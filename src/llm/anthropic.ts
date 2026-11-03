import { llamarHttp, type DefHerramienta, type LlmAdapter, type Mensaje, type RespuestaLLM, type ToolCall } from "./adapter.ts"

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }

type MensajeApi = { role: "user" | "assistant"; content: Bloque[] }

type RespuestaApi = {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxTokens: number

  constructor(o: { apiKey: string; model: string; baseUrl?: string; timeoutMs: number; maxTokens: number }) {
    this.apiKey = o.apiKey
    this.model = o.model
    this.baseUrl = o.baseUrl ?? "https://api.anthropic.com"
    this.timeoutMs = o.timeoutMs
    this.maxTokens = o.maxTokens
  }

  private convertir(mensajes: Mensaje[]): { system: string; messages: MensajeApi[] } {
    const system = mensajes.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
    const messages: MensajeApi[] = []
    const agregar = (role: "user" | "assistant", bloques: Bloque[]) => {
      const ultimo = messages.at(-1)
      // La API exige alternar roles: se fusionan mensajes consecutivos del mismo rol.
      if (ultimo && ultimo.role === role) ultimo.content.push(...bloques)
      else messages.push({ role, content: bloques })
    }
    for (const m of mensajes) {
      if (m.role === "user") agregar("user", [{ type: "text", text: m.content }])
      if (m.role === "tool") agregar("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }])
      if (m.role === "assistant") {
        const bloques: Bloque[] = []
        if (m.content) bloques.push({ type: "text", text: m.content })
        for (const t of m.toolCalls) bloques.push({ type: "tool_use", id: t.id, name: t.name, input: t.args ?? {} })
        if (bloques.length) agregar("assistant", bloques)
      }
    }
    return { system, messages }
  }

  async enviar(mensajes: Mensaje[], herramientas: DefHerramienta[]): Promise<RespuestaLLM> {
    const { system, messages } = this.convertir(mensajes)
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      ...(herramientas.length
        ? { tools: herramientas.map((h) => ({ name: h.name, description: h.description, input_schema: h.parameters })) }
        : {}),
    }
    const r = (await llamarHttp(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
      "Anthropic",
    )) as RespuestaApi
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
    const toolCalls: ToolCall[] = r.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.input }))
    return { text, toolCalls, usage: { input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 } }
  }
}
