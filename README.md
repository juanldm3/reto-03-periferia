# Reto 3 · Agente conversacional de órdenes de compra (SAP simulado)

Agente que lee el paquete de una compra (solicitud, cotización, aprobación y, a veces, factura), lo valida contra los maestros, construye la OC, genera la evidencia de aprobación y la crea en un SAP simulado. Las excepciones se bloquean o se convierten en confirmaciones humanas.

- **Link de prueba:** https://reto-03-periferia.onrender.com
- **Clave de acceso al link:** `periferia2026` (se escribe arriba a la derecha del chat). Protege el saldo de la clave del modelo; el servidor además tiene topes de tokens por sesión y globales.
- El plan gratuito de Render se duerme tras 15 minutos sin uso: la primera visita puede tardar unos 50 segundos.
- Documento de la solución: [SOLUCION.md](SOLUCION.md)

## Requisitos

- Node **22.18 o superior** (corre TypeScript directo, sin compilar). También funciona con Bun.
- Una clave de Anthropic para el chat. `demo.ts` y las pruebas **no** necesitan clave.

## Levantar en local (un comando después de instalar)

```bash
npm install
cp .env.example .env        # en Windows: copy .env.example .env  → escribe tu ANTHROPIC_API_KEY
npm start                   # abre http://localhost:3000
```

`npm start` carga `.env` si existe (`node --env-file-if-exists`). Con Bun: `bun install && bun run src/server.ts`.

## Verificar sin modelo

```bash
npm run demo        # = node demo.ts   (con Bun: bun run demo.ts)
npm test            # pruebas del ciclo del agente (confirmación, idempotencia, errores, tope)
npm run typecheck   # tsc --noEmit
```

`demo.ts` limpia `out/`, procesa `sol-001` a `sol-006` llamando directamente a las herramientas, confirma explícitamente los casos que lo requieren, repite `sol-001` para mostrar la idempotencia y compara cada resultado con lo esperado en el PRD. Sale con código 1 si algo no coincide.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí, para el chat | Clave del modelo. Solo vive en el backend. |
| `LLM_PROVIDER` | No | `anthropic` (defecto) u `openai`. |
| `LLM_MODEL` | No (sí con openai) | Defecto `claude-sonnet-5-5`. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Solo con openai | Segundo adaptador. |
| `APP_ACCESS_KEY` | No | Si existe, el chat pide esa clave (protege tu saldo en el link público). |
| `MAX_ITERACIONES` | No | Tope de llamadas modelo→herramienta por turno (25). |
| `MAX_TOKENS_SESION` / `MAX_TOKENS_GLOBAL` | No | Topes de costo por sesión y por servidor. |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor (60000). |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendiente, error, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión (mensajes y cada llamada a herramienta) |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, requiereClave }` (sin claves) |

Si `APP_ACCESS_KEY` está definida, `/api/chat` y `/api/sessions/:id` exigen el encabezado `x-access-key`.

## Archivos que genera

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado (desde 4500000001) |
| `out/control.csv` | Un registro por intento de creación: creada, idempotente, bloqueada, pendiente_confirmacion, rechazada |
| `out/log.jsonl` | Cada llamada a herramienta |
| `out/<caso>/aprobacion.txt` y `.pdf` | Evidencia de aprobación con sha256 |
| `out/<caso>/trazabilidad.json` | Fuente de cada campo del payload |
| `out/sesiones/<id>.json` | Copia del historial de cada sesión |

## Despliegue en Render (plan gratuito)

1. Sube el repositorio a GitHub.
2. En Render: **New → Blueprint**, elige el repositorio. Render lee `render.yaml`.
3. Escribe el valor de `ANTHROPIC_API_KEY` (y `APP_ACCESS_KEY` si quieres proteger el link) cuando Render lo pida.
4. Espera el build y abre `https://<servicio>.onrender.com/api/health`: debe decir `"configurado": true`.

El plan gratuito se duerme tras 15 minutos sin uso: abre el link un par de minutos antes de la defensa. Los archivos de `out/` se pierden en cada reinicio (es un disco temporal), lo cual es aceptable para el SAP simulado.

## Estructura

```
agent/prompt.md               comportamiento del agente (system prompt)
src/knowledge/                conocimiento del proceso
src/tools/oc.ts               herramientas tipadas con zod (oc_<export>)
src/tools/registry.ts         valida argumentos, ejecuta y registra cada llamada
src/domain/                   lectura del paquete, controles RC1–RC10, payload, evidencia, log de control
src/sap/adapter.ts, mock.ts   interfaz SapAdapter y SAP simulado sobre archivos
src/llm/                      interfaz del proveedor + Anthropic + OpenAI
src/agent/                    ciclo del agente y sesiones
src/server.ts                 API HTTP y archivos del front
web/                          chat en HTML plano
demo.ts                       verificación sin modelo
tests/                        pruebas del ciclo con un modelo guionado
modulo/                       bonus: agente empaquetado (npm run modulo lo regenera)
```
