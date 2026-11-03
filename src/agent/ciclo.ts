import { readFile } from "node:fs/promises"
import path from "node:path"
import { definiciones, ejecutar, type LlamadaEjecutada } from "../tools/registry.ts"
import { LlmError, type LlmAdapter } from "../llm/adapter.ts"
import type { Sesion } from "./sesiones.ts"

export type Limites = { maxIteraciones: number; maxTokensSesion: number; consumirGlobal: (n: number) => boolean }

export type RespuestaTurno = {
  reply: string
  toolCalls: Array<Omit<LlamadaEjecutada, "resultado"> & { resultado: unknown }>
  needsConfirmation: boolean
  pendiente: Sesion["pendiente"]
  error: string | null
}

// System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md). Ninguno está en el código.
export async function cargarSystemPrompt(dir: string): Promise<string> {
  const prompt = await readFile(path.join(dir, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(dir, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

const normalizar = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

// Interpreta la respuesta humana a una confirmación pendiente. Lo decide el servidor, no el modelo.
export function interpretarConfirmacion(texto: string): "si" | "no" | "otro" {
  const t = normalizar(texto)
  if (/\b(no|cancela|cancelar|cancelo|rechazo|rechaza|detente|espera|todavia no)\b/.test(t)) return "no"
  if (/\b(si|confirmo|confirmado|confirma|dale|procede|proceder|adelante|ok|okay|de acuerdo|autorizo|crea|creala|crear)\b/.test(t)) return "si"
  return "otro"
}

function actualizarPendiente(s: Sesion, ll: LlamadaEjecutada) {
  const r = ll.resultado as { ok: boolean; data?: Record<string, unknown>; detalle?: Record<string, unknown> }
  const caso = String((ll.args as { caso?: string })?.caso ?? "").toLowerCase()
  if (ll.name === "oc_validar" && r.ok && r.data?.apta === true) {
    const reglas = (r.data.confirmaciones as Array<{ regla: string }>).map((c) => c.regla)
    if (reglas.length && !s.confirmados.has(caso)) s.pendiente = { caso, reglas }
  }
  if (ll.name === "oc_crear" && !r.ok && r.detalle?.requiere_confirmacion === true) {
    const reglas = (r.detalle.confirmaciones as Array<{ regla: string }>).map((c) => c.regla)
    s.pendiente = { caso, reglas }
  }
  if (ll.name === "oc_crear" && r.ok) {
    s.confirmados.delete(caso)
    if (s.pendiente?.caso === caso) s.pendiente = null
  }
}

export async function ejecutarTurno(
  dir: string,
  llm: LlmAdapter,
  s: Sesion,
  textoUsuario: string,
  limites: Limites,
): Promise<RespuestaTurno> {
  const toolCalls: RespuestaTurno["toolCalls"] = []
  const ahora = () => new Date().toISOString()
  s.eventos.push({ tipo: "usuario", texto: textoUsuario, ts: ahora() })

  if (s.tokens >= limites.maxTokensSesion) {
    const reply = `Esta sesión alcanzó el tope de ${limites.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
    s.eventos.push({ tipo: "error", texto: reply, ts: ahora() })
    return { reply, toolCalls, needsConfirmation: false, pendiente: s.pendiente, error: "tope_tokens_sesion" }
  }

  // CA3: el servidor (no el modelo) decide si el mensaje confirma la acción pendiente.
  let contenido = textoUsuario
  if (s.pendiente) {
    const decision = interpretarConfirmacion(textoUsuario)
    if (decision === "si") {
      s.confirmados.add(s.pendiente.caso)
      contenido += `\n\n[Nota del sistema: el usuario CONFIRMÓ explícitamente las excepciones ${s.pendiente.reglas.join(", ")} del caso ${s.pendiente.caso}. Ya puedes llamar oc_crear con confirmado=true.]`
      s.pendiente = null
    } else if (decision === "no") {
      contenido += `\n\n[Nota del sistema: el usuario NO confirmó el caso ${s.pendiente.caso}. No crees la OC.]`
      s.pendiente = null
    }
  }

  const system = await cargarSystemPrompt(dir)
  s.mensajes.push({ role: "user", content: contenido })
  const herramientas = definiciones()
  const ctx = { directory: dir, sessionId: s.id, confirmacionHumana: (caso: string) => s.confirmados.has(caso.toLowerCase()) }

  try {
    for (let i = 0; i < limites.maxIteraciones; i++) {
      const r = await llm.enviar([{ role: "system", content: system }, ...s.mensajes], herramientas)
      const usados = r.usage.input + r.usage.output
      s.tokens += usados
      if (!limites.consumirGlobal(usados)) throw new LlmError("Se alcanzó el tope global de tokens del servidor. Avisa al administrador.")
      s.mensajes.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls })

      if (!r.toolCalls.length) return cerrar(s, r.text, toolCalls)

      for (const tc of r.toolCalls) {
        const ll = await ejecutar(tc.name, tc.args, ctx)
        toolCalls.push(ll)
        s.eventos.push({ tipo: "herramienta", name: ll.name, args: ll.args, ok: ll.ok, resumen: ll.resumen, resultado: ll.resultado, ts: ahora() })
        s.mensajes.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: JSON.stringify(ll.resultado) })
        actualizarPendiente(s, ll)
      }
    }
    // CA1: tope alcanzado → respuesta con lo que hay, sin más herramientas.
    s.mensajes.push({ role: "user", content: `[Nota del sistema: se alcanzó el tope de ${limites.maxIteraciones} iteraciones. Resume lo que obtuviste y lo que falta, sin llamar herramientas.]` })
    const final = await llm.enviar([{ role: "system", content: system }, ...s.mensajes], [])
    s.tokens += final.usage.input + final.usage.output
    s.mensajes.push({ role: "assistant", content: final.text, toolCalls: [] })
    return cerrar(s, final.text, toolCalls)
  } catch (e) {
    // CA5: el error se muestra en lenguaje claro y la sesión sigue viva.
    const texto = e instanceof LlmError ? e.message : `Error inesperado: ${e instanceof Error ? e.message : String(e)}`
    s.eventos.push({ tipo: "error", texto, ts: ahora() })
    return { reply: texto, toolCalls, needsConfirmation: s.pendiente !== null, pendiente: s.pendiente, error: texto }
  }
}

function cerrar(s: Sesion, texto: string, toolCalls: RespuestaTurno["toolCalls"]): RespuestaTurno {
  const needsConfirmation = s.pendiente !== null
  s.eventos.push({ tipo: "agente", texto, ts: new Date().toISOString(), needsConfirmation })
  return { reply: texto, toolCalls, needsConfirmation, pendiente: s.pendiente, error: null }
}
