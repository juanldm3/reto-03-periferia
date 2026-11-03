import path from "node:path"

// Acepta "sol-004", "SOL-004" o el id de la solicitud "SOL-2026-004".
export function normalizarCaso(caso: string): string {
  const limpio = caso.trim().toLowerCase()
  const largo = /^sol-\d{4}-(\d{3})$/.exec(limpio)
  const nombre = largo ? `sol-${largo[1]}` : limpio
  if (!/^[a-z0-9-]{1,40}$/.test(nombre)) {
    throw new Error(`Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, por ejemplo "sol-001".`)
  }
  return nombre
}

export const rutas = {
  caso: (dir: string, caso: string) => path.join(dir, "fixtures", "reto-03", "solicitudes", caso),
  maestros: (dir: string) => path.join(dir, "fixtures", "reto-03", "maestros"),
  out: (dir: string) => path.join(dir, "out"),
  outCaso: (dir: string, caso: string) => path.join(dir, "out", caso),
  sap: (dir: string) => path.join(dir, "out", "sap"),
}

// Rutas que se devuelven al modelo/usuario: siempre relativas a la raíz del proyecto.
export function relativa(dir: string, ruta: string): string {
  return path.relative(dir, ruta).split(path.sep).join("/")
}
