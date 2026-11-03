import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { leerAprobacionRaw } from "./paquete.ts"
import { relativa, rutas } from "./rutas.ts"
import type { AprobacionRaw } from "./tipos.ts"

export type Evidencia = { ruta: string; ruta_pdf: string; sha256: string }

export function contenidoEvidencia(caso: string, a: AprobacionRaw): string {
  return [
    `EVIDENCIA DE APROBACIÓN - caso ${caso}`,
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
  ].join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

async function generarPdf(contenido: string, hash: string, fecha: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  // Fechas fijas para que el PDF sea determinista entre ejecuciones.
  const f = new Date(fecha)
  doc.setCreationDate(f)
  doc.setModificationDate(f)
  doc.setTitle("Evidencia de aprobación")
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const pagina = doc.addPage([595, 842])
  let y = 800
  for (const linea of [...contenido.split("\n"), "", `sha256: ${hash}`]) {
    pagina.drawText(linea, { x: 50, y, size: linea.startsWith("sha256") ? 8 : 11, font: fuente })
    y -= 18
  }
  return doc.save()
}

export async function generarEvidencia(dir: string, caso: string): Promise<Evidencia> {
  const raw = await leerAprobacionRaw(dir, caso)
  const contenido = contenidoEvidencia(caso, raw)
  const hash = sha256(contenido)
  const carpeta = rutas.outCaso(dir, caso)
  await mkdir(carpeta, { recursive: true })
  const txt = path.join(carpeta, "aprobacion.txt")
  const pdf = path.join(carpeta, "aprobacion.pdf")
  await writeFile(txt, `${contenido}\n\n---\nsha256: ${hash}\n`, "utf8")
  await writeFile(pdf, await generarPdf(contenido, hash, raw.fecha))
  return { ruta: relativa(dir, txt), ruta_pdf: relativa(dir, pdf), sha256: hash }
}
