import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Mensaje } from "../llm/adapter.ts"

export type EventoVisible =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "agente"; texto: string; ts: string; needsConfirmation: boolean }
  | { tipo: "herramienta"; name: string; args: unknown; ok: boolean; resumen: string; resultado: unknown; ts: string }
  | { tipo: "error"; texto: string; ts: string }

export type Pendiente = { caso: string; reglas: string[] }

export type Sesion = {
  id: string
  mensajes: Mensaje[] // historial que ve el modelo
  eventos: EventoVisible[] // historial que ve la persona (incluye cada llamada a herramienta)
  pendiente: Pendiente | null // confirmación humana esperada (CA3)
  confirmados: Set<string> // casos cuyo usuario confirmó en el chat
  tokens: number
}

const sesiones = new Map<string, Sesion>()

export function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id)
  if (!s) {
    s = { id, mensajes: [], eventos: [], pendiente: null, confirmados: new Set(), tokens: 0 }
    sesiones.set(id, s)
  }
  return s
}

export function buscarSesion(id: string): Sesion | undefined {
  return sesiones.get(id)
}

// Copia en archivo para auditoría; la fuente de verdad es la memoria del proceso.
export async function guardarSesion(dir: string, s: Sesion): Promise<void> {
  const carpeta = path.join(dir, "out", "sesiones")
  await mkdir(carpeta, { recursive: true })
  const datos = { id: s.id, eventos: s.eventos, pendiente: s.pendiente, confirmados: [...s.confirmados], tokens: s.tokens }
  await writeFile(path.join(carpeta, `${s.id}.json`), JSON.stringify(datos, null, 2), "utf8")
}
