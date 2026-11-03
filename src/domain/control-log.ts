import { appendFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { rutas } from "./rutas.ts"

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "rechazada"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

function csv(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

// HU-5: cada intento (exitoso, bloqueado o pendiente) agrega una fila a out/control.csv
export async function registrarControl(dir: string, f: FilaControl): Promise<void> {
  const out = rutas.out(dir)
  await mkdir(out, { recursive: true })
  const ruta = path.join(out, "control.csv")
  if (!existsSync(ruta)) await appendFile(ruta, `${COLUMNAS}\n`, "utf8")
  const fila = [f.solicitud_id, f.resultado, f.numero_oc ?? "", String(f.retroactiva), f.bloqueos.join("|"), f.confirmaciones.join("|"), new Date().toISOString()]
  await appendFile(ruta, `${fila.map(csv).join(",")}\n`, "utf8")
}

// CA4: toda llamada a herramienta queda en out/log.jsonl
export async function registrarLlamada(dir: string, entrada: Record<string, unknown>): Promise<void> {
  const out = rutas.out(dir)
  await mkdir(out, { recursive: true })
  await appendFile(path.join(out, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`, "utf8")
}
