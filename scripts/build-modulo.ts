// Genera modulo/ (bonus 9.4) a partir de las MISMAS piezas que usa la aplicación:
// agent/prompt.md → modulo/agent.md, src/knowledge/ordenes-compra.md → modulo/skill/ordenes-compra/SKILL.md.
// modulo/tools/oc.ts re-exporta src/tools/oc.ts (mismo código, no una copia).
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const raiz = process.cwd()
const leer = (p: string) => readFile(path.join(raiz, p), "utf8")

const prompt = await leer("agent/prompt.md")
const conocimiento = await leer("src/knowledge/ordenes-compra.md")

const agente = `---
description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de correo (solicitud, cotización, aprobación, factura).
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}`

const skill = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia - reglas de control RC1-RC10, OC retroactivas y datos del SAP simulado.
---

${conocimiento}`

await mkdir(path.join(raiz, "modulo", "skill", "ordenes-compra"), { recursive: true })
await mkdir(path.join(raiz, "modulo", "tools"), { recursive: true })
await writeFile(path.join(raiz, "modulo", "agent.md"), agente, "utf8")
await writeFile(path.join(raiz, "modulo", "skill", "ordenes-compra", "SKILL.md"), skill, "utf8")
await writeFile(
  path.join(raiz, "modulo", "tools", "oc.ts"),
  `// Mismas herramientas que usa la aplicación (sin depender del servidor HTTP).\nexport * from "../../src/tools/oc.ts"\n`,
  "utf8",
)
console.log("modulo/ regenerado desde agent/prompt.md, src/knowledge/ y src/tools/oc.ts")
