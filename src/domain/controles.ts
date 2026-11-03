import { normalizarNit, normalizarNombre } from "./paquete.ts"
import type { CentroCosto, Derivado, EstadoControl, Hallazgo, Maestros, Paquete, Proveedor, Regla, Validacion } from "./tipos.ts"

export const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 %
export const TOLERANCIA_ARITMETICA = 1 // RC10: ± 1 unidad monetaria

const fmt = (n: number) => n.toLocaleString("es-CO")

export function buscarProveedor(p: Paquete, m: Maestros): { proveedor: Proveedor | null; por: "nit" | "nombre" } {
  const nit = p.solicitud.proveedor_nit
  if (nit) {
    const n = normalizarNit(nit)
    return { proveedor: m.proveedores.find((x) => normalizarNit(x.nit) === n) ?? null, por: "nit" }
  }
  const nombre = normalizarNombre(p.solicitud.proveedor_nombre)
  return { proveedor: m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre) ?? null, por: "nombre" }
}

export function fechaDe(isoConHora: string): string {
  return isoConHora.slice(0, 10) // fecha local tal como la escribió el remitente
}

class Acumulador {
  bloqueos: Hallazgo[] = []
  confirmaciones: Hallazgo[] = []
  controles: Validacion["controles"] = []
  registrar(regla: Regla, estado: EstadoControl, detalle: string) {
    this.controles.push({ regla, estado, detalle })
  }
  bloquear(h: Hallazgo) {
    this.bloqueos.push(h)
    this.registrar(h.regla, "bloqueo", h.mensaje)
  }
  confirmar(h: Hallazgo) {
    this.confirmaciones.push(h)
    this.registrar(h.regla, "confirmacion", h.mensaje)
  }
}

function rc1(p: Paquete, m: Maestros, a: Acumulador): Proveedor | null {
  const { proveedor, por } = buscarProveedor(p, m)
  const id = por === "nit" ? `NIT ${p.solicitud.proveedor_nit}` : `nombre "${p.solicitud.proveedor_nombre}"`
  if (!proveedor) {
    a.bloquear({
      regla: "RC1",
      mensaje: `El proveedor con ${id} no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar a datos maestros la creación del proveedor (RUT y certificación bancaria) antes de crear la OC.",
      valores: { proveedor: p.solicitud.proveedor_nombre, nit: p.solicitud.proveedor_nit ?? null },
    })
    return null
  }
  if (!proveedor.activo) {
    a.bloquear({
      regla: "RC1",
      mensaje: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) existe pero está inactivo.`,
      accion_sugerida: "Pedir a datos maestros que lo reactive o pedir al solicitante otro proveedor.",
    })
    return null
  }
  a.registrar("RC1", "ok", `Proveedor ${proveedor.nombre} encontrado por ${por}, código SAP ${proveedor.codigo_sap}, activo.`)
  return proveedor
}

function rc4(p: Paquete, m: Maestros, a: Acumulador): CentroCosto | null {
  const centro = m.centros.find((c) => c.centro_costo === p.solicitud.centro_costo) ?? null
  if (!centro) {
    a.bloquear({
      regla: "RC4",
      mensaje: `El centro de costo ${p.solicitud.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Pedir al solicitante el centro de costo correcto.",
    })
    return null
  }
  if (!centro.subareas.includes(p.solicitud.subarea)) {
    a.bloquear({
      regla: "RC4",
      mensaje: `La subárea "${p.solicitud.subarea}" no pertenece al centro ${centro.centro_costo} (${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante que corrija la subárea o el centro de costo.",
    })
  } else {
    a.registrar("RC4", "ok", `Subárea ${p.solicitud.subarea} pertenece a ${centro.centro_costo}.`)
  }
  return centro
}

function rc2rc3(p: Paquete, m: Maestros, centro: CentroCosto | null, a: Acumulador) {
  const ap = p.aprobacion
  const total = p.solicitud.valor_total
  if (!ap) {
    a.bloquear({ regla: "RC2", mensaje: "No hay correo de aprobación en el paquete.", accion_sugerida: "Pedir al solicitante el correo de aprobación de su líder." })
    a.registrar("RC3", "no_aplica", "Sin aprobación no se puede evaluar el tope.")
    return
  }
  if (!ap.aprobado) {
    a.bloquear({ regla: "RC2", mensaje: `El correo de ${ap.de} no contiene la palabra "Aprobado".`, accion_sugerida: "Pedir al líder una aprobación explícita." })
    a.registrar("RC3", "no_aplica", "Sin aprobación explícita no se evalúa el tope.")
    return
  }
  if (!centro) {
    a.registrar("RC2", "no_aplica", "El centro de costo no existe; no hay matriz de aprobación contra la cual comparar.")
    a.registrar("RC3", "no_aplica", "El centro de costo no existe.")
    return
  }
  const aprobador = centro.aprobadores.find((x) => x.email.toLowerCase() === ap.de.toLowerCase())
  if (!aprobador) {
    const otroCentro = m.centros.find((c) => c.aprobadores.some((x) => x.email.toLowerCase() === ap.de.toLowerCase()))
    const validos = centro.aprobadores.filter((x) => x.tope >= total)
    const accion = validos.length
      ? `Pedir aprobación a: ${validos.map((v) => `${v.nombre ?? v.email} (tope ${fmt(v.tope)})`).join(", ")}.`
      : `Ningún aprobador de ${centro.centro_costo} cubre ${fmt(total)} (${centro.aprobadores.map((v) => `${v.nombre ?? v.email} tope ${fmt(v.tope)}`).join(", ")}). Escalar al dueño del centro de costo para definir quién aprueba.`
    a.bloquear({
      regla: "RC2",
      mensaje: `${ap.de} no es aprobador del centro ${centro.centro_costo}${otroCentro ? ` (es aprobador de ${otroCentro.centro_costo})` : ""}.`,
      accion_sugerida: accion,
      valores: { aprobo: ap.de, centro_costo: centro.centro_costo, valor_total: total },
    })
    a.registrar("RC3", "no_aplica", "El remitente no es aprobador del centro; el tope no se evalúa.")
    return
  }
  a.registrar("RC2", "ok", `Aprobado por ${aprobador.email}, aprobador de ${centro.centro_costo}.`)
  if (total > aprobador.tope) {
    a.bloquear({
      regla: "RC3",
      mensaje: `El valor ${fmt(total)} supera el tope de ${aprobador.email} (${fmt(aprobador.tope)}).`,
      accion_sugerida: "Pedir aprobación a un aprobador con tope suficiente.",
      valores: { valor_total: total, tope: aprobador.tope },
    })
  } else {
    a.registrar("RC3", "ok", `Valor ${fmt(total)} dentro del tope ${fmt(aprobador.tope)}.`)
  }
}

function rc5(p: Paquete, a: Acumulador) {
  const c = p.cotizacion
  const s = p.solicitud
  if (!c) {
    a.confirmar({ regla: "RC5", mensaje: "No hay cotización en el paquete.", accion_sugerida: "Confirmar que se crea la OC sin cotización o pedirla al solicitante." })
    return
  }
  const diferencia = c.total - s.valor_total
  const pct = Math.abs(diferencia) / s.valor_total
  const detalle = `solicitud ${fmt(s.valor_total)} vs cotización ${fmt(c.total)} (${(pct * 100).toFixed(2)} %)`
  if (pct > TOLERANCIA_COTIZACION) {
    a.confirmar({
      regla: "RC5",
      mensaje: `La cotización difiere de la solicitud más del 2 %: ${detalle}.`,
      accion_sugerida: "Confirmar que la OC se crea por el valor de la solicitud (el aprobado) o pedir una solicitud corregida.",
      valores: { valor_solicitud: s.valor_total, valor_cotizacion: c.total, diferencia, porcentaje: Number((pct * 100).toFixed(2)) },
    })
  } else {
    a.registrar("RC5", "ok", `Cotización cuadra: ${detalle}.`)
  }
}

function derivar(valor: string, fuente: string, detalle: string): Derivado {
  return { valor, fuente, detalle }
}

function rc6rc7(p: Paquete, m: Maestros, prov: Proveedor | null, a: Acumulador): Validacion["derivados"] {
  const d: Validacion["derivados"] = {}
  const s = p.solicitud
  if (s.indicador_iva) {
    a.registrar("RC6", "ok", `Indicador de IVA informado en la solicitud: ${s.indicador_iva}.`)
  } else if (prov) {
    const iva = m.iva.find((x) => x.codigo === prov.indicador_iva_default)
    d.indicador_iva = derivar(prov.indicador_iva_default, "maestro.proveedores.indicador_iva_default", iva?.descripcion ?? "")
    a.confirmar({
      regla: "RC6",
      mensaje: `La solicitud no trae indicador de IVA. Se propone ${prov.indicador_iva_default} (${iva?.descripcion ?? "sin descripción"}), el default del proveedor.`,
      accion_sugerida: `Confirmar el indicador ${prov.indicador_iva_default} o indicar otro.`,
      valores: { indicador_propuesto: prov.indicador_iva_default },
    })
  } else {
    a.registrar("RC6", "no_aplica", "Falta el indicador de IVA y no hay proveedor válido del cual derivarlo.")
  }
  if (s.condiciones_pago) {
    a.registrar("RC7", "ok", `Condiciones de pago informadas: ${s.condiciones_pago}.`)
  } else if (prov) {
    const cp = m.condiciones.find((x) => x.codigo === prov.condiciones_pago_default)
    d.condiciones_pago = derivar(prov.condiciones_pago_default, "maestro.proveedores.condiciones_pago_default", cp?.descripcion ?? "")
    a.registrar("RC7", "derivado", `Sin condiciones de pago en la solicitud; se usa ${prov.condiciones_pago_default} (${cp?.descripcion ?? ""}) del proveedor.`)
  } else {
    a.registrar("RC7", "no_aplica", "Faltan condiciones de pago y no hay proveedor válido del cual derivarlas.")
  }
  return d
}

function rc8(p: Paquete, a: Acumulador): boolean {
  const f = p.factura
  if (f && f.fecha < p.solicitud.fecha_solicitud) {
    a.confirmar({
      regla: "RC8",
      mensaje: `OC retroactiva: la factura ${f.numero} es del ${f.fecha}, anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que se crea la OC retroactiva. Quedará marcada retroactiva=true en el log de control.",
      valores: { factura: f.numero, fecha_factura: f.fecha, fecha_solicitud: p.solicitud.fecha_solicitud },
    })
    return true
  }
  a.registrar("RC8", f ? "ok" : "no_aplica", f ? `Factura ${f.numero} posterior a la solicitud.` : "No hay factura en el paquete.")
  return false
}

function rc9(p: Paquete, a: Acumulador) {
  if (!p.aprobacion) {
    a.registrar("RC9", "no_aplica", "Sin aprobación.")
    return
  }
  const fa = fechaDe(p.aprobacion.fecha)
  if (fa < p.solicitud.fecha_solicitud) {
    a.confirmar({
      regla: "RC9",
      mensaje: `La aprobación (${fa}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      valores: { fecha_aprobacion: fa, fecha_solicitud: p.solicitud.fecha_solicitud },
    })
  } else {
    a.registrar("RC9", "ok", `Aprobación del ${fa}, igual o posterior a la solicitud (${p.solicitud.fecha_solicitud}).`)
  }
}

function rc10(p: Paquete, a: Acumulador) {
  const s = p.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    a.bloquear({
      regla: "RC10",
      mensaje: `cantidad × valor_unitario = ${fmt(calculado)} no coincide con valor_total ${fmt(s.valor_total)}.`,
      accion_sugerida: "Pedir al solicitante que corrija la solicitud.",
      valores: { calculado, valor_total: s.valor_total },
    })
  } else {
    a.registrar("RC10", "ok", `${s.cantidad} × ${fmt(s.valor_unitario)} = ${fmt(s.valor_total)}.`)
  }
}

export function validarPaquete(p: Paquete, m: Maestros): Validacion {
  const a = new Acumulador()
  const proveedor = rc1(p, m, a)
  const centro = rc4(p, m, a)
  rc2rc3(p, m, centro, a)
  rc5(p, a)
  const derivados = rc6rc7(p, m, proveedor, a)
  const retroactiva = rc8(p, a)
  rc9(p, a)
  rc10(p, a)
  const orden: Regla[] = ["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"]
  a.controles.sort((x, y) => orden.indexOf(x.regla) - orden.indexOf(y.regla))
  return { apta: a.bloqueos.length === 0, bloqueos: a.bloqueos, confirmaciones: a.confirmaciones, derivados, retroactiva, controles: a.controles }
}
