import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { config, crearLlm } from "./config.ts"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { buscarSesion, guardarSesion, obtenerSesion } from "./agent/sesiones.ts"

const DIR = process.cwd()
const llm = crearLlm()
let tokensGlobales = 0
const consumirGlobal = (n: number) => (tokensGlobales += n) <= config.maxTokensGlobal

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/).optional(),
  message: z.string().trim().min(1).max(4000),
})

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let total = 0
  const partes: Buffer[] = []
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > 32_000) throw new Error("Cuerpo demasiado grande")
    partes.push(c as Buffer)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

function autorizado(req: IncomingMessage): boolean {
  if (!config.accessKey) return true
  const dada = Buffer.from(String(req.headers["x-access-key"] ?? ""))
  const esperada = Buffer.from(config.accessKey)
  return dada.length === esperada.length && timingSafeEqual(dada, esperada)
}

// Una conversación a la vez por sesión: evita turnos cruzados.
const ocupadas = new Set<string>()

async function chat(req: IncomingMessage, res: ServerResponse) {
  if (!autorizado(req)) return json(res, 401, { error: "Clave de acceso inválida o ausente." })
  let cuerpo: z.infer<typeof ChatSchema>
  try {
    const parsed = ChatSchema.safeParse(await leerCuerpo(req))
    if (!parsed.success) return json(res, 400, { error: "Se espera { sessionId?, message } con un mensaje de 1 a 4000 caracteres." })
    cuerpo = parsed.data
  } catch {
    return json(res, 400, { error: "JSON inválido." })
  }
  const sessionId = cuerpo.sessionId ?? randomUUID()
  if (!llm.adapter) {
    return json(res, 503, { sessionId, reply: `El modelo no está configurado: ${llm.problema} Mientras tanto puedes correr demo.ts, que usa las mismas herramientas sin modelo.`, toolCalls: [], needsConfirmation: false, error: llm.problema })
  }
  if (ocupadas.has(sessionId)) return json(res, 409, { error: "Esta sesión ya está procesando un mensaje." })
  ocupadas.add(sessionId)
  try {
    const s = obtenerSesion(sessionId)
    const r = await ejecutarTurno(DIR, llm.adapter, s, cuerpo.message, { maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion, consumirGlobal })
    await guardarSesion(DIR, s).catch(() => undefined)
    json(res, 200, { sessionId, ...r, tokensSesion: s.tokens })
  } finally {
    ocupadas.delete(sessionId)
  }
}

const servidor = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, provider: llm.provider, model: llm.model, configurado: llm.adapter !== null, requiereClave: config.accessKey !== "" })
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res)
    const sesion = /^\/api\/sessions\/([a-zA-Z0-9-]+)$/.exec(url.pathname)
    if (req.method === "GET" && sesion) {
      if (!autorizado(req)) return json(res, 401, { error: "Clave de acceso inválida o ausente." })
      const s = buscarSesion(sesion[1] ?? "")
      if (!s) return json(res, 404, { error: "Sesión no encontrada." })
      return json(res, 200, { id: s.id, eventos: s.eventos, pendiente: s.pendiente, tokens: s.tokens })
    }
    const estatico = req.method === "GET" ? ESTATICOS[url.pathname] : undefined
    if (estatico) {
      res.writeHead(200, { "content-type": estatico.tipo })
      return res.end(await readFile(path.join(DIR, "web", estatico.archivo)))
    }
    json(res, 404, { error: "No encontrado" })
  } catch (e) {
    console.error("Error en el servidor:", e instanceof Error ? e.message : e)
    if (!res.headersSent) json(res, 500, { error: "Error interno del servidor." })
  }
})

servidor.listen(config.port, () => {
  console.log(`Agente OC escuchando en http://localhost:${config.port}`)
  console.log(`Modelo: ${llm.provider} / ${llm.model} ${llm.adapter ? "(configurado)" : `(NO configurado: ${llm.problema})`}`)
})
