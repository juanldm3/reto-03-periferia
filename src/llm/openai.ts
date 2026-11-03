import { llamarHttp, type DefHerramienta, type LlmAdapter, type Mensaje, type RespuestaLLM } from "./adapter.ts"

type RespuestaApi = {
  choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

// Segunda implementación: demuestra que cambiar de proveedor no toca el ciclo del agente.
// Sirve para OpenAI o cualquier API compatible con Chat Completions (OPENAI_BASE_URL).
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = "openai"
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxTokens: number

  constructor(o: { apiKey: string; model: string; baseUrl?: string; timeoutMs: number; maxTokens: number }) {
    this.apiKey = o.apiKey
    this.model = o.model
    this.baseUrl = o.baseUrl ?? "https://api.openai.com/v1"
    this.timeoutMs = o.timeoutMs
    this.maxTokens = o.maxTokens
  }

  async enviar(mensajes: Mensaje[], herramientas: DefHerramienta[]): Promise<RespuestaLLM> {
    const messages = mensajes.map((m) => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls.length
            ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) }
            : {}),
        }
      }
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
      return { role: m.role, content: m.content }
    })
    const body = {
      model: this.model,
      max_completion_tokens: this.maxTokens,
      messages,
      ...(herramientas.length
        ? { tools: herramientas.map((h) => ({ type: "function", function: { name: h.name, description: h.description, parameters: h.parameters } })) }
        : {}),
    }
    const r = (await llamarHttp(
      `${this.baseUrl}/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) },
      this.timeoutMs,
      "OpenAI",
    )) as RespuestaApi
    const msg = r.choices[0]?.message
    const toolCalls = (msg?.tool_calls ?? []).map((t) => {
      let args: unknown = {}
      try {
        args = JSON.parse(t.function.arguments)
      } catch {
        args = { _argumentos_invalidos: t.function.arguments }
      }
      return { id: t.id, name: t.function.name, args }
    })
    return { text: msg?.content ?? "", toolCalls, usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 } }
  }
}
