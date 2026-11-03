import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { buscarProveedor, fechaDe } from "./controles.ts"
import { relativa, rutas } from "./rutas.ts"
import { OrdenCompraSchema, type Maestros, type OrdenCompra, type Paquete, type Validacion } from "./tipos.ts"

export const LIMITE_TEXTO_BREVE = 40

// Supuesto documentado: "horas" en la descripción => unidad H; en otro caso UN.
export function unidadDe(descripcion: string): "UN" | "H" {
  return /\bhoras?\b/i.test(descripcion) ? "H" : "UN"
}

export function textoBreve(descripcion: string): string {
  return descripcion.length <= LIMITE_TEXTO_BREVE ? descripcion : descripcion.slice(0, LIMITE_TEXTO_BREVE).trimEnd()
}

type Trazabilidad = Record<string, { valor: string | number | null; fuente: string }>

export type PayloadConstruido = { payload: OrdenCompra; trazabilidad: string }

export async function construirPayload(
  dir: string,
  p: Paquete,
  m: Maestros,
  v: Validacion,
  evidenciaSha: string,
  confirmadoPor: string | null,
): Promise<PayloadConstruido> {
  if (!v.apta) throw new Error(`No se construye payload: la solicitud tiene bloqueos (${v.bloqueos.map((b) => b.regla).join(", ")}).`)
  const { proveedor } = buscarProveedor(p, m)
  if (!proveedor || !p.aprobacion) throw new Error("Faltan proveedor o aprobación válidos.")
  const s = p.solicitud
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const condiciones = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  if (!iva || !condiciones) throw new Error("No fue posible determinar indicador de IVA o condiciones de pago.")

  const payload = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condiciones,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion: textoBreve(s.descripcion),
        cantidad: s.cantidad,
        unidad: unidadDe(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.mensaje, confirmado_por: confirmadoPor })),
  })

  const traza: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: payload.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante (PRD 7.4)" },
    organizacion_compras: { valor: "1000", fuente: "constante (PRD 7.4)" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: { valor: condiciones, fuente: s.condiciones_pago ? "solicitud" : "derivado (maestro.proveedores.condiciones_pago_default)" },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: p.aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha, fuente: "derivado (sha256 de out/<caso>/aprobacion.txt)" },
    "posiciones[0].descripcion": { valor: payload.posiciones[0]?.descripcion ?? "", fuente: `solicitud (recortada a ${LIMITE_TEXTO_BREVE} caracteres; original: "${s.descripcion}")` },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: payload.posiciones[0]?.unidad ?? "", fuente: "derivado (regla: 'horas' en la descripción → H, si no UN)" },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud (validado contra maestro.centros-costo)" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud (validado contra maestro.centros-costo)" },
    "posiciones[0].indicador_iva": { valor: iva, fuente: s.indicador_iva ? "solicitud" : "derivado (maestro.proveedores.indicador_iva_default)" },
  }
  const carpeta = rutas.outCaso(dir, p.caso)
  await mkdir(carpeta, { recursive: true })
  const ruta = path.join(carpeta, "trazabilidad.json")
  await writeFile(ruta, JSON.stringify({ solicitud_id: s.solicitud_id, campos: traza, fecha_aprobacion: fechaDe(p.aprobacion.fecha) }, null, 2), "utf8")
  return { payload, trazabilidad: relativa(dir, ruta) }
}

// Campos que el modelo no puede alterar: si el payload que envía difiere, oc_crear lo rechaza.
export function huellaPayload(o: OrdenCompra): string {
  return JSON.stringify({
    ref: o.referencia.solicitud_id,
    prov: o.proveedor.codigo_sap,
    moneda: o.moneda,
    cp: o.condiciones_pago,
    aprobador: o.aprobador.email,
    pos: o.posiciones.map((x) => [x.cantidad, x.precio_unitario, x.centro_costo, x.subarea, x.indicador_iva, x.unidad]),
  })
}
