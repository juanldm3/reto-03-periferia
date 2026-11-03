// Prueba del ciclo del agente con un modelo de PRUEBA guionado (no es el agente real).
// Verifica la mecánica que no depende del modelo: confirmación humana, bloqueo del atajo
// "confirmado=true" sin que el usuario confirme, idempotencia y manejo de errores del proveedor.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ejecutarTurno, interpretarConfirmacion } from "../src/agent/ciclo.ts"
import { obtenerSesion } from "../src/agent/sesiones.ts"
import { LlmError, type LlmAdapter, type Mensaje, type RespuestaLLM } from "../src/llm/adapter.ts"

function proyectoTemporal(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reto03-"))
  const raiz = process.cwd()
  for (const p of ["fixtures", "agent", path.join("src", "knowledge")]) cpSync(path.join(raiz, p), path.join(dir, p), { recursive: true })
  return dir
}

class ModeloGuionado implements LlmAdapter {
  readonly provider = "prueba"
  readonly model = "guion"
  private readonly pasos: Array<RespuestaLLM | Error>
  vistos: Mensaje[][] = []
  constructor(pasos: Array<RespuestaLLM | Error>) {
    this.pasos = pasos
  }
  async enviar(m: Mensaje[]): Promise<RespuestaLLM> {
    this.vistos.push(m)
    const p = this.pasos.shift()
    if (!p) throw new Error("guion agotado")
    if (p instanceof Error) throw p
    return p
  }
}

const tc = (id: string, name: string, args: unknown): RespuestaLLM => ({ text: "", toolCalls: [{ id, name, args }], usage: { input: 10, output: 5 } })
const texto = (t: string): RespuestaLLM => ({ text: t, toolCalls: [], usage: { input: 10, output: 5 } })
const limites = { maxIteraciones: 25, maxTokensSesion: 100_000, consumirGlobal: () => true }

test("sol-004: el atajo confirmado=true sin confirmación humana se rechaza; tras 'confirmo' se crea", async () => {
  const dir = proyectoTemporal()
  const s = obtenerSesion("prueba-sol-004")
  const modelo = new ModeloGuionado([
    tc("1", "oc_validar", { caso: "sol-004" }),
    tc("2", "oc_crear", { caso: "sol-004", confirmado: true }), // el modelo intenta saltarse al humano
    texto("¿Confirmas que cree la OC por 25.000.000?"),
    tc("3", "oc_crear", { caso: "sol-004", confirmado: true }),
    texto("OC creada."),
  ])
  const t1 = await ejecutarTurno(dir, modelo, s, "Procesa sol-004 y no la crees hasta que confirme", limites)
  assert.equal(t1.toolCalls[1]?.ok, false, "oc_crear debe fallar sin confirmación humana")
  assert.equal(t1.needsConfirmation, true)
  assert.deepEqual(t1.pendiente, { caso: "sol-004", reglas: ["RC5"] })

  const t2 = await ejecutarTurno(dir, modelo, s, "Confirmo", limites)
  const creada = t2.toolCalls[0]?.resultado as { ok: boolean; data: { numero_oc: string } }
  assert.equal(creada.ok, true)
  assert.equal(creada.data.numero_oc, "4500000001")
  assert.equal(t2.needsConfirmation, false)
})

test("sol-001: flujo normal crea sin confirmación y el segundo intento es idempotente", async () => {
  const dir = proyectoTemporal()
  const s = obtenerSesion("prueba-sol-001")
  const modelo = new ModeloGuionado([tc("1", "oc_crear", { caso: "sol-001" }), tc("2", "oc_crear", { caso: "sol-001" }), texto("listo")])
  const t = await ejecutarTurno(dir, modelo, s, "procesa sol-001", limites)
  const [a, b] = t.toolCalls.map((x) => x.resultado as { ok: boolean; data: { numero_oc: string; idempotente: boolean } })
  assert.equal(a?.data.idempotente, false)
  assert.equal(b?.data.idempotente, true)
  assert.equal(a?.data.numero_oc, b?.data.numero_oc)
})

test("args inválidos se devuelven al modelo como error, sin romper el turno", async () => {
  const dir = proyectoTemporal()
  const s = obtenerSesion("prueba-args")
  const modelo = new ModeloGuionado([tc("1", "oc_validar", { caso: 123 }), texto("revisé")])
  const t = await ejecutarTurno(dir, modelo, s, "valida", limites)
  assert.equal(t.toolCalls[0]?.ok, false)
  assert.match(String((t.toolCalls[0]?.resultado as { error: string }).error), /Argumentos inválidos/)
})

test("un error del proveedor se informa en claro y la sesión sigue", async () => {
  const dir = proyectoTemporal()
  const s = obtenerSesion("prueba-error")
  const modelo = new ModeloGuionado([new LlmError("El modelo no respondió en 60 s."), texto("hola de nuevo")])
  const t1 = await ejecutarTurno(dir, modelo, s, "hola", limites)
  assert.equal(t1.error, "El modelo no respondió en 60 s.")
  const t2 = await ejecutarTurno(dir, modelo, s, "¿sigues ahí?", limites)
  assert.equal(t2.reply, "hola de nuevo")
})

test("tope de iteraciones: responde con lo que tiene sin más herramientas", async () => {
  const dir = proyectoTemporal()
  const s = obtenerSesion("prueba-tope")
  const modelo = new ModeloGuionado([tc("1", "oc_leer_paquete", { caso: "sol-001" }), tc("2", "oc_leer_paquete", { caso: "sol-001" }), texto("Tope alcanzado: leí el paquete, falta validar.")])
  const t = await ejecutarTurno(dir, modelo, s, "procesa", { ...limites, maxIteraciones: 2 })
  assert.equal(t.toolCalls.length, 2)
  assert.match(t.reply, /Tope alcanzado/)
})

test("interpretación de la respuesta humana", () => {
  assert.equal(interpretarConfirmacion("Sí, confirmo"), "si")
  assert.equal(interpretarConfirmacion("No, cancela"), "no")
  assert.equal(interpretarConfirmacion("¿qué significa RC5?"), "otro")
})
