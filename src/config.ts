import { AnthropicAdapter } from "./llm/anthropic.ts"
import { OpenAiAdapter } from "./llm/openai.ts"
import type { LlmAdapter } from "./llm/adapter.ts"

const num = (v: string | undefined, def: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}

export const config = {
  port: num(process.env.PORT, 3000),
  provider: (process.env.LLM_PROVIDER || "anthropic").toLowerCase(),
  maxIteraciones: num(process.env.MAX_ITERACIONES, 25), // CA1
  maxTokensSesion: num(process.env.MAX_TOKENS_SESION, 300_000), // tope de costo por sesión
  maxTokensGlobal: num(process.env.MAX_TOKENS_GLOBAL, 3_000_000), // tope de costo de todo el servidor
  maxTokensRespuesta: num(process.env.LLM_MAX_TOKENS, 2048),
  timeoutMs: num(process.env.LLM_TIMEOUT_MS, 60_000),
  accessKey: process.env.APP_ACCESS_KEY ?? "",
}

export type EstadoLlm = { adapter: LlmAdapter | null; provider: string; model: string; problema: string | null }

// La clave solo se lee del entorno del backend; nunca sale en respuestas ni logs.
export function crearLlm(): EstadoLlm {
  const base = { timeoutMs: config.timeoutMs, maxTokens: config.maxTokensRespuesta }
  if (config.provider === "openai") {
    const model = process.env.LLM_MODEL || ""
    const apiKey = process.env.OPENAI_API_KEY ?? ""
    if (!apiKey || !model) return { adapter: null, provider: "openai", model, problema: "Faltan OPENAI_API_KEY y/o LLM_MODEL en el entorno del backend." }
    return { adapter: new OpenAiAdapter({ ...base, apiKey, model, baseUrl: process.env.OPENAI_BASE_URL || undefined }), provider: "openai", model, problema: null }
  }
  const model = process.env.LLM_MODEL || "claude-sonnet-5-5"
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ""
  if (!apiKey) return { adapter: null, provider: "anthropic", model, problema: "Falta ANTHROPIC_API_KEY en el entorno del backend." }
  return { adapter: new AnthropicAdapter({ ...base, apiKey, model, baseUrl: process.env.LLM_BASE_URL || undefined }), provider: "anthropic", model, problema: null }
}
