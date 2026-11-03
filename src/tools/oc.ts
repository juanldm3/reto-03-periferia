import { z } from "zod"
import { leerMaestros, leerPaquete } from "../domain/paquete.ts"
import { validarPaquete } from "../domain/controles.ts"
import { generarEvidencia } from "../domain/evidencia.ts"
import { construirPayload, huellaPayload } from "../domain/payload.ts"
import { registrarControl } from "../domain/control-log.ts"
import { normalizarCaso } from "../domain/rutas.ts"
import { OrdenCompraSchema, type Paquete, type ToolContext, type ToolResult, type Validacion } from "../domain/tipos.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"

// Cada export es una herramienta; el modelo la ve como oc_<export>.
// Regla de diseño: las herramientas vuelven a leer los fixtures y maestros en cada llamada.
// Lo que el modelo envía como "paquete" o "payload" nunca se usa como fuente de valores.

const caso = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')

const responder = <T>(r: ToolResult<T>): string => JSON.stringify(r)

const fallo = (e: unknown, detalle?: unknown): string =>
  responder({ ok: false, error: e instanceof Error ? e.message : String(e), ...(detalle === undefined ? {} : { detalle }) })

// Único punto donde se elige la implementación SAP. Para producción se cambia aquí por el adaptador real.
const crearSap = (dir: string): SapAdapter => new SapMock(dir)

async function cargar(dir: string, nombre: string): Promise<{ paquete: Paquete; validacion: Validacion; maestros: Awaited<ReturnType<typeof leerMaestros>> }> {
  const paquete = await leerPaquete(dir, nombre)
  const maestros = await leerMaestros(dir)
  return { paquete, validacion: validarPaquete(paquete, maestros), maestros }
}

const codigos = (v: Validacion) => ({ bloqueos: v.bloqueos.map((b) => b.regla), confirmaciones: v.confirmaciones.map((c) => c.regla) })

export const leer_paquete = {
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      return responder({ ok: true, data: await leerPaquete(ctx.directory, normalizarCaso(args.caso)) })
    } catch (e) {
      return fallo(e)
    }
  },
}

export const validar = {
  description: "Aplica las reglas de control RC1 a RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones, derivados, retroactiva y el estado de cada control.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: la herramienta vuelve a leer el paquete desde los fixtures para que nadie altere los datos."),
  },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ToolContext): Promise<string> {
    try {
      const { validacion } = await cargar(ctx.directory, normalizarCaso(args.caso))
      return responder({ ok: true, data: validacion })
    } catch (e) {
      return fallo(e)
    }
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación en out/<caso>/aprobacion.txt y aprobacion.pdf, y devuelve la ruta y el sha256 del contenido.",
  args: { caso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      return responder({ ok: true, data: await generarEvidencia(ctx.directory, normalizarCaso(args.caso)) })
    } catch (e) {
      return fallo(e)
    }
  },
}

export const construir_payload = {
  description: "Construye la orden de compra tal como quedaría en SAP (validada con zod), guarda la trazabilidad de cada campo y no crea nada en SAP.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: la herramienta relee el paquete desde los fixtures."),
    derivados: z.unknown().optional().describe("Opcional. Se ignora: los derivados se recalculan desde los maestros."),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: ToolContext): Promise<string> {
    try {
      const nombre = normalizarCaso(args.caso)
      const { paquete, validacion, maestros } = await cargar(ctx.directory, nombre)
      if (!validacion.apta) return fallo(new Error("La solicitud tiene bloqueos; no se construye la OC."), codigos(validacion))
      const evidencia = await generarEvidencia(ctx.directory, nombre)
      const r = await construirPayload(ctx.directory, paquete, maestros, validacion, evidencia.sha256, null)
      return responder({ ok: true, data: { payload: r.payload, trazabilidad: r.trazabilidad, evidencia, confirmaciones_pendientes: codigos(validacion).confirmaciones } })
    } catch (e) {
      return fallo(e)
    }
  },
}

export const crear = {
  description: "Crea la OC en el SAP simulado solo si no hay bloqueos y las confirmaciones fueron aprobadas por el usuario; es idempotente por solicitud_id.",
  args: {
    caso,
    payload: z.record(z.string(), z.unknown()).optional().describe("Payload devuelto por oc_construir_payload. Se reconstruye en el servidor y se rechaza si fue alterado."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje."),
  },
  async execute(args: { caso: string; payload?: Record<string, unknown>; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    try {
      const nombre = normalizarCaso(args.caso)
      const dir = ctx.directory
      const { paquete, validacion, maestros } = await cargar(dir, nombre)
      const sid = paquete.solicitud.solicitud_id
      const base = { solicitud_id: sid, retroactiva: validacion.retroactiva, ...codigos(validacion) }
      const sap = crearSap(dir)

      // Idempotencia: si ya existe, se devuelve el número existente.
      const existente = await sap.buscarOrdenPorReferencia(sid)
      if (existente) {
        await registrarControl(dir, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return responder({ ok: true, data: { numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: validacion.retroactiva } })
      }

      if (!validacion.apta) {
        await registrarControl(dir, { ...base, resultado: "bloqueada", numero_oc: null })
        return fallo(new Error(`OC bloqueada por ${base.bloqueos.join(", ")}. No se crea.`), { bloqueos: validacion.bloqueos })
      }

      const requiere = validacion.confirmaciones.length > 0
      const humano = ctx.confirmacionHumana ? ctx.confirmacionHumana(nombre) : true
      if (requiere && (args.confirmado !== true || !humano)) {
        await registrarControl(dir, { ...base, resultado: "pendiente_confirmacion", numero_oc: null })
        const motivo = args.confirmado === true && !humano
          ? "El usuario todavía no confirmó en el chat. Termina el turno preguntándole."
          : "Requiere confirmación humana antes de crear."
        return fallo(new Error(`${motivo} Pendiente: ${base.confirmaciones.join(", ")}.`), { requiere_confirmacion: true, confirmaciones: validacion.confirmaciones })
      }

      const proveedorSap = paquete.solicitud.proveedor_nit ? await sap.consultarProveedor(paquete.solicitud.proveedor_nit) : null
      if (paquete.solicitud.proveedor_nit && !proveedorSap?.activo) {
        await registrarControl(dir, { ...base, resultado: "rechazada", numero_oc: null })
        return fallo(new Error("SAP no reporta el proveedor como activo."))
      }

      const evidencia = await generarEvidencia(dir, nombre)
      const quien = requiere ? `analista (sesión ${ctx.sessionId})` : null
      const { payload, trazabilidad } = await construirPayload(dir, paquete, maestros, validacion, evidencia.sha256, quien)

      if (args.payload) {
        const enviado = OrdenCompraSchema.safeParse(args.payload)
        if (!enviado.success || huellaPayload(enviado.data) !== huellaPayload(payload)) {
          await registrarControl(dir, { ...base, resultado: "rechazada", numero_oc: null })
          return fallo(new Error("El payload enviado no coincide con el construido desde los datos validados. No se crea. Usa el payload de oc_construir_payload sin modificarlo."))
        }
      }

      const creada = await sap.crearOrden(payload)
      await registrarControl(dir, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
      return responder({ ok: true, data: { ...creada, idempotente: false, retroactiva: validacion.retroactiva, evidencia: evidencia.ruta, evidencia_pdf: evidencia.ruta_pdf, trazabilidad } })
    } catch (e) {
      return fallo(e)
    }
  },
}
