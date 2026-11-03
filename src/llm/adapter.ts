// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce este contrato.

export type ToolCall = { id: string; name: string; args: unknown }

export type Mensaje =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export type DefHerramienta = { name: string; description: string; parameters: Record<string, unknown> }

export type RespuestaLLM = { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number } }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: Mensaje[], herramientas: DefHerramienta[]): Promise<RespuestaLLM>
}

export class LlmError extends Error {}

// fetch con timeout y mensajes de error legibles para el chat (CA5)
export async function llamarHttp(url: string, init: RequestInit, timeoutMs: number, proveedor: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const nombre = e instanceof Error ? e.name : ""
    if (nombre === "TimeoutError" || nombre === "AbortError") {
      throw new LlmError(`El modelo (${proveedor}) no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`)
    }
    throw new LlmError(`No pude conectarme con ${proveedor}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const texto = await res.text()
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new LlmError(`${proveedor} rechazó la clave de API (HTTP ${res.status}). Revisa la variable de entorno.`)
    if (res.status === 429) throw new LlmError(`${proveedor} indica límite de uso alcanzado (HTTP 429). Espera un momento.`)
    throw new LlmError(`${proveedor} respondió HTTP ${res.status}: ${texto.slice(0, 300)}`)
  }
  return JSON.parse(texto)
}
