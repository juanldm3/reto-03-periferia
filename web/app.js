// Front de chat en HTML plano. Toda la lógica de negocio vive en el backend.
const $ = (id) => document.getElementById(id)
const chat = $("chat")
let enviando = false

const almacen = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* sin almacenamiento */ } },
}
let sessionId = almacen.get("sessionId") || crypto.randomUUID()
almacen.set("sessionId", sessionId)
$("clave").value = almacen.get("clave") || ""

function escapar(t) {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function inline(t) {
  return t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

// Markdown mínimo: tablas, listas, títulos, negrita y código.
function markdown(texto) {
  const lineas = escapar(texto).split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:-]+\|/.test(lineas[i + 1] || "")) {
      const celdas = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()))
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<table><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`)
      continue
    }
    if (/^\s*[-*] /.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*[-*] /.test(lineas[i])) items.push(inline(lineas[i++].replace(/^\s*[-*] /, "")))
      html.push(`<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`)
      continue
    }
    const titulo = /^(#{1,4})\s+(.*)$/.exec(l)
    if (titulo) html.push(`<p><strong>${inline(titulo[2])}</strong></p>`)
    else if (l.trim()) html.push(`<p>${inline(l)}</p>`)
    i++
  }
  return html.join("")
}

function agregar(clase, html) {
  const div = document.createElement("div")
  div.className = `msg ${clase}`
  div.innerHTML = html
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return div
}

function mostrarHerramienta(t) {
  const div = document.createElement("details")
  div.className = `tool ${t.ok ? "" : "falla"}`
  div.innerHTML = `<summary>🔧 <code class="nombre">${escapar(t.name)}</code>(${escapar(JSON.stringify(t.args))}) → ${escapar(t.resumen)}</summary>
    <pre>${escapar(JSON.stringify(t.resultado, null, 2))}</pre>`
  chat.appendChild(div)
}

function mostrarConfirmacion(pendiente) {
  $("confirmacion").hidden = !pendiente
  if (pendiente) $("confirmacion-detalle").textContent = `Caso ${pendiente.caso}: ${pendiente.reglas.join(", ")}`
}

async function enviar(texto) {
  if (enviando || !texto.trim()) return
  enviando = true
  $("enviar").disabled = true
  document.querySelector(".bienvenida")?.remove()
  agregar("usuario", escapar(texto))
  const pensando = agregar("pensando", "El agente está pensando…")
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-key": $("clave").value },
      body: JSON.stringify({ sessionId, message: texto }),
    })
    const r = await res.json()
    pensando.remove()
    if (res.status === 401) return agregar("error", "Clave de acceso inválida. Escríbela arriba a la derecha.")
    for (const t of r.toolCalls || []) mostrarHerramienta(t)
    if (r.error) agregar("error", escapar(r.reply || r.error))
    else agregar(`agente ${r.needsConfirmation ? "espera" : ""}`, markdown(r.reply || "(sin texto)"))
    mostrarConfirmacion(r.needsConfirmation ? r.pendiente : null)
  } catch (e) {
    pensando.remove()
    agregar("error", `No pude contactar el servidor: ${escapar(String(e))}`)
  } finally {
    enviando = false
    $("enviar").disabled = false
    chat.scrollTop = chat.scrollHeight
  }
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault()
  const t = $("mensaje").value
  $("mensaje").value = ""
  enviar(t)
})
$("si").addEventListener("click", () => enviar("Confirmo, crea la OC."))
$("no").addEventListener("click", () => enviar("No, cancela. No crees la OC."))
$("clave").addEventListener("change", () => almacen.set("clave", $("clave").value))
$("nueva").addEventListener("click", () => {
  sessionId = crypto.randomUUID()
  almacen.set("sessionId", sessionId)
  location.reload()
})
document.querySelectorAll(".sugerencias button").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.msg)))

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    $("modelo").textContent = h.configurado ? `Modelo: ${h.provider} · ${h.model}` : `⚠️ Modelo sin configurar (${h.provider})`
    $("clave").hidden = !h.requiereClave
  })
  .catch(() => ($("modelo").textContent = "Servidor no disponible"))
