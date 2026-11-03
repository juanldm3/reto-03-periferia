// Verificación sin modelo: procesa sol-001..sol-006 llamando directamente a las herramientas.
// Uso: node demo.ts   (o: bun run demo.ts)
import { rm } from "node:fs/promises"
import { ejecutar } from "./src/tools/registry.ts"
import type { ToolContext } from "./src/domain/tipos.ts"

const ctx: ToolContext = { directory: process.cwd(), sessionId: "demo" }

type Hallazgo = { regla: string; mensaje: string; accion_sugerida: string }
type Validacion = { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean; derivados: Record<string, { valor: string }> }
type Resultado<T> = { ok: boolean; error?: string; data?: T }

// Esperado según PRD sección 3.1 (O1–O4)
const esperado: Record<string, { bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean; creaOc: "sin_confirmar" | "con_confirmacion" | "no"; texto: string }> = {
  "sol-001": { bloqueos: [], confirmaciones: [], retroactiva: false, creaOc: "sin_confirmar", texto: "OC creada sin intervención humana (O1)" },
  "sol-002": { bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, creaOc: "no", texto: "Bloqueo: proveedor inexistente (O2)" },
  "sol-003": { bloqueos: ["RC2"], confirmaciones: [], retroactiva: false, creaOc: "no", texto: "Bloqueo: aprobador sin autoridad (O2)" },
  "sol-004": { bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, creaOc: "con_confirmacion", texto: "Confirmación: cotización ≠ solicitud (O3)" },
  "sol-005": { bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, creaOc: "con_confirmacion", texto: "Confirmación y retroactiva=true (O4)" },
  "sol-006": { bloqueos: [], confirmaciones: ["RC6"], retroactiva: false, creaOc: "con_confirmacion", texto: "Confirmación: IVA no informado, se deriva (O3)" },
}

const linea = (s = "") => console.log(s)
const codigos = (h: Hallazgo[]) => h.map((x) => x.regla).sort().join(",")

async function crear(caso: string, confirmado?: boolean) {
  return (await ejecutar("oc_crear", { caso, ...(confirmado ? { confirmado: true } : {}) }, ctx)).resultado as Resultado<{ numero_oc: string; idempotente: boolean; evidencia?: string }>
}

async function procesar(caso: string) {
  linea(`\n━━━ ${caso} ━━━`)
  const paquete = (await ejecutar("oc_leer_paquete", { caso }, ctx)).resultado as Resultado<{ faltantes: string[] }>
  if (!paquete.ok) {
    linea(`  leer_paquete → error: ${paquete.error}`)
    return { caso, ok: false, obtenido: `error de lectura: ${paquete.error}` }
  }
  const v = ((await ejecutar("oc_validar", { caso }, ctx)).resultado as Resultado<Validacion>).data
  if (!v) return { caso, ok: false, obtenido: "error de validación" }
  linea(`  apta: ${v.apta}   retroactiva: ${v.retroactiva}`)
  for (const b of v.bloqueos) linea(`  ✖ BLOQUEO ${b.regla}: ${b.mensaje}\n      → acción: ${b.accion_sugerida}`)
  for (const c of v.confirmaciones) linea(`  ? CONFIRMAR ${c.regla}: ${c.mensaje}`)
  for (const [k, d] of Object.entries(v.derivados)) linea(`  ↳ derivado ${k} = ${d.valor}`)

  if (v.apta) {
    const p = (await ejecutar("oc_construir_payload", { caso }, ctx)).resultado as Resultado<{ trazabilidad: string }>
    linea(`  payload: ${p.ok ? `válido (trazabilidad en ${p.data?.trazabilidad})` : p.error}`)
  }

  const intento1 = await crear(caso)
  let numero = intento1.ok ? intento1.data?.numero_oc : undefined
  let creadaSinConfirmar = intento1.ok
  linea(`  oc_crear (sin confirmar) → ${intento1.ok ? `OC ${numero}` : intento1.error}`)

  let creadaConConfirmacion = false
  if (!intento1.ok && v.apta && v.confirmaciones.length) {
    linea(`  >> El usuario confirma explícitamente: "Confirmo, crea la OC"`)
    const intento2 = await crear(caso, true)
    numero = intento2.ok ? intento2.data?.numero_oc : undefined
    creadaConConfirmacion = intento2.ok
    linea(`  oc_crear (confirmado=true) → ${intento2.ok ? `OC ${numero}, evidencia ${intento2.data?.evidencia}` : intento2.error}`)
  }

  const e = esperado[caso]
  if (!e) return { caso, ok: false, obtenido: "caso sin resultado esperado definido" }
  const creaOc = creadaSinConfirmar ? "sin_confirmar" : creadaConConfirmacion ? "con_confirmacion" : "no"
  const ok = codigos(v.bloqueos) === e.bloqueos.join(",") && codigos(v.confirmaciones) === e.confirmaciones.join(",") && v.retroactiva === e.retroactiva && creaOc === e.creaOc
  const obtenido = [
    v.bloqueos.length ? `bloqueo ${codigos(v.bloqueos)}` : null,
    v.confirmaciones.length ? `confirmación ${codigos(v.confirmaciones)}` : null,
    v.retroactiva ? "retroactiva=true" : null,
    numero ? `OC ${numero}${creaOc === "con_confirmacion" ? " tras confirmar" : ""}` : "sin OC",
  ].filter(Boolean).join(" · ")
  return { caso, ok, obtenido, esperado: e.texto }
}

async function main() {
  await rm("out", { recursive: true, force: true }) // determinismo: out/ se limpia al inicio
  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]
  const resultados = []
  for (const c of casos) resultados.push(await procesar(c))

  linea("\n━━━ Idempotencia: sol-001 por segunda vez ━━━")
  const repetida = await crear("sol-001")
  const idemOk = repetida.ok && repetida.data?.idempotente === true && repetida.data.numero_oc === "4500000001"
  linea(`  oc_crear → OC ${repetida.data?.numero_oc} idempotente=${repetida.data?.idempotente}  ${idemOk ? "✔" : "✖"}`)

  linea("\n━━━ Resumen: esperado (PRD) vs obtenido ━━━")
  for (const r of resultados) linea(`  ${r.ok ? "✔" : "✖"} ${r.caso}  esperado: ${r.esperado ?? "-"}\n             obtenido: ${r.obtenido}`)
  linea(`  ${idemOk ? "✔" : "✖"} sol-001 repetida  esperado: mismo número 4500000001 · obtenido: ${repetida.data?.numero_oc}`)
  linea("\nArchivos: out/control.csv, out/log.jsonl, out/sap/ordenes.jsonl, out/<caso>/{aprobacion.txt,aprobacion.pdf,trazabilidad.json}")
  const todo = resultados.every((r) => r.ok) && idemOk
  linea(todo ? "\nRESULTADO: los 6 casos coinciden con el PRD." : "\nRESULTADO: hay diferencias con el PRD.")
  process.exitCode = todo ? 0 : 1
}

await main()
