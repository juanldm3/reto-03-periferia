import { z } from "zod"
import * as oc from "./oc.ts"
import { registrarLlamada } from "../domain/control-log.ts"
import type { ToolContext } from "../domain/tipos.ts"
import type { DefHerramienta } from "../llm/adapter.ts"

type Herramienta = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: never, ctx: ToolContext): Promise<string>
}

function esHerramienta(x: unknown): x is Herramienta {
  return typeof x === "object" && x !== null && "description" in x && "args" in x && "execute" in x
}

// Nombre visible para el modelo: <archivo>_<export>
const herramientas = new Map<string, Herramienta>(
  Object.entries(oc)
    .filter(([, v]) => esHerramienta(v))
    .map(([k, v]) => [`oc_${k}`, v as Herramienta]),
)

export function definiciones(): DefHerramienta[] {
  return [...herramientas.entries()].map(([name, h]) => {
    const { $schema: _omitido, ...parameters } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { name, description: h.description, parameters }
  })
}

export type LlamadaEjecutada = { name: string; args: unknown; ok: boolean; resultado: unknown; resumen: string }

// Valida argumentos con zod antes de ejecutar; un error se devuelve al modelo, nunca se lanza.
export async function ejecutar(name: string, args: unknown, ctx: ToolContext): Promise<LlamadaEjecutada> {
  const h = herramientas.get(name)
  let texto: string
  if (!h) {
    texto = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${name}` })
  } else {
    const parsed = z.object(h.args).safeParse(args ?? {})
    texto = parsed.success
      ? await h.execute(parsed.data as never, ctx)
      : JSON.stringify({ ok: false, error: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` })
  }
  const resultado = JSON.parse(texto) as { ok: boolean; error?: string; data?: unknown }
  const resumen = resumir(name, resultado)
  await registrarLlamada(ctx.directory, { sessionId: ctx.sessionId, herramienta: name, args, ok: resultado.ok, resumen }).catch(() => undefined)
  return { name, args, ok: resultado.ok, resultado, resumen }
}

function resumir(name: string, r: { ok: boolean; error?: string; data?: unknown }): string {
  if (!r.ok) return `Error: ${r.error ?? "desconocido"}`
  const d = r.data as Record<string, unknown>
  switch (name) {
    case "oc_leer_paquete": {
      const faltantes = (d.faltantes as string[]) ?? []
      return `Paquete leído${d.factura ? " (incluye factura)" : ""}${faltantes.length ? `; faltan: ${faltantes.join(", ")}` : ""}`
    }
    case "oc_validar": {
      const b = (d.bloqueos as Array<{ regla: string }>).map((x) => x.regla)
      const c = (d.confirmaciones as Array<{ regla: string }>).map((x) => x.regla)
      return `apta=${String(d.apta)} · bloqueos: ${b.join(", ") || "ninguno"} · confirmaciones: ${c.join(", ") || "ninguna"} · retroactiva=${String(d.retroactiva)}`
    }
    case "oc_construir_payload":
      return `Payload válido; trazabilidad en ${String(d.trazabilidad)}`
    case "oc_generar_evidencia":
      return `Evidencia en ${String(d.ruta)} (sha256 ${String(d.sha256).slice(0, 12)}…)`
    case "oc_crear":
      return `OC ${String(d.numero_oc)}${d.idempotente ? " (ya existía, idempotente)" : " creada"}`
    default:
      return "ok"
  }
}
