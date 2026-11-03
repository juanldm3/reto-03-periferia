import { z } from "zod"

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato AAAA-MM-DD")

// Excel de solicitud normalizado (PRD 7.1). Campos con "?" pueden faltar.
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }),
  valor_total: z.number({ error: "valor_total debe ser numérico" }),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fecha,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionRaw = z.infer<typeof AprobacionRawSchema>

export type Cotizacion = {
  referencia: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = {
  de: string
  para: string
  asunto: string
  fecha: string
  aprobado: boolean
  texto: string
}

export type Factura = { numero: string; fecha: string; total: number }

// Paquete normalizado (PRD 7.2)
export type Paquete = {
  caso: string
  correo: z.infer<typeof CorreoSchema>
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  faltantes: string[]
}

// Maestros
export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: z.infer<typeof IndicadorIvaSchema>[]
  condiciones: z.infer<typeof CondicionPagoSchema>[]
}

// Resultado de controles
export type Regla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"
export type EstadoControl = "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"

export type Hallazgo = {
  regla: Regla
  mensaje: string
  accion_sugerida: string
  valores?: Record<string, string | number | boolean | null>
}

export type Derivado = { valor: string; fuente: string; detalle: string }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: { indicador_iva?: Derivado; condiciones_pago?: Derivado }
  retroactiva: boolean
  controles: Array<{ regla: Regla; estado: EstadoControl; detalle: string }>
}

// Payload de la OC (PRD 7.4)
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

// Contexto que recibe cada herramienta
export type ToolContext = {
  directory: string
  sessionId: string
  // Lo inyecta el servidor: true solo si el usuario confirmó en el chat. En demo.ts no existe.
  confirmacionHumana?: (caso: string) => boolean
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string; detalle?: unknown }
