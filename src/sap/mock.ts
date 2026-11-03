import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { leerMaestros, normalizarNit } from "../domain/paquete.ts"
import { rutas } from "../domain/rutas.ts"
import type { OrdenCompra } from "../domain/tipos.ts"
import type { SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

// SAP simulado sobre archivos: out/sap/ordenes.jsonl (una OC por línea).
export class SapMock implements SapAdapter {
  private readonly dir: string
  private readonly archivo: string

  constructor(dir: string) {
    this.dir = dir
    this.archivo = path.join(rutas.sap(dir), "ordenes.jsonl")
  }

  private async leer(): Promise<Registro[]> {
    if (!existsSync(this.archivo)) return []
    const texto = await readFile(this.archivo, "utf8")
    return texto
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string) {
    const m = await leerMaestros(this.dir)
    const p = m.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = (await this.leer()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra) {
    const existentes = await this.leer()
    const numero_oc = String(PRIMER_NUMERO + existentes.length)
    const fecha = new Date().toISOString()
    await mkdir(rutas.sap(this.dir), { recursive: true })
    await appendFile(this.archivo, `${JSON.stringify({ numero_oc, fecha, orden })}\n`, "utf8")
    return { numero_oc, fecha }
  }
}
