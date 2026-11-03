import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import {
  AprobacionRawSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  SolicitudSchema,
  type Aprobacion,
  type Cotizacion,
  type Factura,
  type Maestros,
  type Paquete,
} from "./tipos.ts"
import { rutas } from "./rutas.ts"

// "COP 11.400.000" -> 11400000 (formato colombiano: punto = miles, coma = decimales)
export function parsearMonto(texto: string): number {
  const limpio = texto.replace(/\./g, "").replace(",", ".")
  const n = Number(limpio)
  if (!Number.isFinite(n)) throw new Error(`Monto no numérico: "${texto}"`)
  return n
}

// "900.555.111-2" -> "900555111" (se quita el dígito de verificación)
export function normalizarNit(nit: string): string {
  return nit.replace(/-\d$/, "").replace(/\D/g, "")
}

export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function sumarDias(fechaIso: string, dias: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): Cotizacion {
  const referencia = /COTIZACI[ÓO]N\s+(\S+)/i.exec(texto)?.[1] ?? null
  const proveedor = /^Proveedor:\s*(.+)$/m.exec(texto)?.[1]?.trim() ?? ""
  const nitTexto = /^NIT:\s*([\d.\-]+)/m.exec(texto)?.[1]
  const totales = [...texto.matchAll(/^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/gm)]
  const ultimo = totales.at(-1)
  if (!ultimo) throw new Error("La cotización no tiene una línea TOTAL legible")
  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m.exec(texto)?.[1]
  const validezDias = /Validez de la oferta:\s*(\d+)\s*d[ií]as/i.exec(texto)?.[1]
  return {
    referencia,
    proveedor,
    nit: nitTexto ? normalizarNit(nitTexto) : null,
    total: parsearMonto(ultimo[2] ?? ""),
    moneda: ultimo[1] ?? "",
    validez_hasta: fecha && validezDias ? sumarDias(fecha, Number(validezDias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): Factura {
  const numero = /No\.\s*(\S+)/.exec(texto)?.[1]
  const fecha = /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  const total = /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m.exec(texto)?.[1]
  if (!numero || !fecha || !total) throw new Error("La factura no tiene número, fecha de emisión o total legibles")
  return { numero, fecha, total: parsearMonto(total) }
}

export function interpretarAprobacion(raw: z.infer<typeof AprobacionRawSchema>): Aprobacion {
  const cuerpo = raw.cuerpo
  const dice = /\baprobado\b/i.test(cuerpo)
  const niega = /\bno\s+(est[aá]\s+)?aprobado\b/i.test(cuerpo)
  return { de: raw.de, para: raw.para, asunto: raw.asunto, fecha: raw.fecha, aprobado: dice && !niega, texto: cuerpo }
}

async function leerJson(ruta: string): Promise<unknown> {
  const texto = await readFile(ruta, "utf8")
  try {
    return JSON.parse(texto)
  } catch {
    throw new Error(`${path.basename(ruta)} no es un JSON válido`)
  }
}

function errorZod(archivo: string, e: z.ZodError): Error {
  const campos = e.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  return new Error(`${archivo} tiene datos inválidos → ${campos}`)
}

async function leerValidado<T>(ruta: string, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await leerJson(ruta))
  if (!parsed.success) throw errorZod(path.basename(ruta), parsed.error)
  return parsed.data
}

export async function leerPaquete(dir: string, caso: string): Promise<Paquete> {
  const base = rutas.caso(dir, caso)
  if (!existsSync(base)) throw new Error(`No existe el caso "${caso}" en fixtures/reto-03/solicitudes/`)
  const ruta = (f: string) => path.join(base, f)
  const faltantes: string[] = []
  const existe = (f: string) => {
    const ok = existsSync(ruta(f))
    if (!ok) faltantes.push(f)
    return ok
  }

  if (!existe("solicitud.json")) throw new Error("Falta solicitud.json en el paquete: pedir al solicitante el Excel de solicitud.")
  if (!existe("correo.json")) throw new Error("Falta correo.json en el paquete: no hay correo de entrada que referenciar.")

  const solicitud = await leerValidado(ruta("solicitud.json"), SolicitudSchema)
  const correo = await leerValidado(ruta("correo.json"), CorreoSchema)
  const cotizacion = existe("cotizacion.txt") ? parsearCotizacion(await readFile(ruta("cotizacion.txt"), "utf8")) : null
  const aprobacion = existe("aprobacion.json")
    ? interpretarAprobacion(await leerValidado(ruta("aprobacion.json"), AprobacionRawSchema))
    : null
  // La factura solo existe en compras retroactivas: su ausencia no es un faltante.
  const factura = existsSync(ruta("factura.txt")) ? parsearFactura(await readFile(ruta("factura.txt"), "utf8")) : null

  return { caso, correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }, solicitud, cotizacion, aprobacion, factura, faltantes }
}

export async function leerAprobacionRaw(dir: string, caso: string) {
  const r = path.join(rutas.caso(dir, caso), "aprobacion.json")
  if (!existsSync(r)) throw new Error("Falta aprobacion.json: no hay correo de aprobación para generar evidencia.")
  return leerValidado(r, AprobacionRawSchema)
}

export async function leerMaestros(dir: string): Promise<Maestros> {
  const m = rutas.maestros(dir)
  return {
    proveedores: await leerValidado(path.join(m, "proveedores.json"), z.array(ProveedorSchema)),
    centros: await leerValidado(path.join(m, "centros-costo.json"), z.array(CentroCostoSchema)),
    iva: await leerValidado(path.join(m, "indicadores-iva.json"), z.array(IndicadorIvaSchema)),
    condiciones: await leerValidado(path.join(m, "condiciones-pago.json"), z.array(CondicionPagoSchema)),
  }
}
