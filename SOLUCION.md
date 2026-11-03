# SOLUCIÓN · Reto 3 · Agente de órdenes de compra

## 1. Problema en una frase

La analista administrativa digita a mano cada OC en SAP y revisa de memoria si quien aprobó podía aprobar ese monto; eso le cuesta tiempo a ella, le cuesta correcciones a contabilidad en el cierre y deja a la dirección sin saber cuántas OC se crean después de la factura.

## 2. Arquitectura

```
┌──────────────┐  POST /api/chat  ┌───────────────────────────────────────────────┐
│ web/ (chat)  │ ───────────────▶ │ src/server.ts  (HTTP, clave de acceso, topes)  │
│ - historial  │ ◀─────────────── │   └─ src/agent/ciclo.ts  (bucle del agente)    │
│ - tool calls │                  │        ├─ src/llm/adapter.ts → anthropic.ts    │
│ - confirmar  │                  │        │                     → openai.ts       │
└──────────────┘                  │        └─ src/tools/registry.ts (zod + log)    │
                                  │             └─ src/tools/oc.ts (herramientas)  │
                                  │                  ├─ src/domain/ (reglas)       │
                                  │                  └─ src/sap/mock.ts            │
                                  └──────────┬──────────────────────┬─────────────┘
                                             │                      │
                                fixtures/ (solo lectura)      out/ (escritura)
```

| Qué | Dónde | Por qué ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo conversa, qué orden sigue, cuándo pregunta. |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Qué significa cada regla y el contexto del proceso. Se concatena al prompt en cada turno. |
| Ejecución | `src/tools/oc.ts` + `src/domain/` | Las reglas RC1–RC10 son código. Cambiar una regla no toca el servidor. |

`demo.ts` y las pruebas importan las mismas herramientas sin levantar el servidor.

## 3. Ciclo del agente

`src/agent/ciclo.ts`, por cada mensaje:

1. Si había una confirmación pendiente, **el servidor** (no el modelo) interpreta el mensaje: "confirmo", "sí", "dale" → marca el caso como confirmado; "no", "cancela" → lo descarta. Agrega una nota de sistema al mensaje para que el modelo lo sepa.
2. Llama al modelo con el prompt, el historial y las 5 herramientas.
3. Si el modelo pide herramientas, el registro valida los argumentos con zod, ejecuta, guarda la llamada en `out/log.jsonl` y en el historial visible, y devuelve el resultado al modelo.
4. Repite hasta que el modelo responda sin herramientas o hasta **25 iteraciones** (`MAX_ITERACIONES`). Al llegar al tope, hace una última llamada sin herramientas pidiendo "lo que tengo y lo que falta" (CA1).
5. Responde `{ reply, toolCalls, needsConfirmation, pendiente }`. El front resalta en amarillo el mensaje y muestra los botones "Confirmo" / "No, cancela".

**Confirmación humana (CA3), con doble candado:**
- `oc_crear` rechaza crear si hay confirmaciones y `confirmado` no es `true`.
- Aunque el modelo envíe `confirmado: true`, el servidor inyecta en `ctx.confirmacionHumana` si el usuario de verdad confirmó en el chat. Si no, se rechaza. Ejemplo: en `sol-004` el modelo no puede crear la OC en el mismo turno en que detecta la diferencia de 6 %. Esto está probado en `tests/ciclo.test.ts`.

**Errores (CA5):** timeout de 60 s al proveedor, 401/429 traducidos a mensajes claros; la sesión sigue viva.

**Costo:** tope de tokens por sesión (`MAX_TOKENS_SESION`) y global (`MAX_TOKENS_GLOBAL`), una sola petición a la vez por sesión, mensajes de máximo 4.000 caracteres y clave de acceso opcional para el link público (`APP_ACCESS_KEY`).

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5` (configurable con `LLM_MODEL`).
- **Por qué:** sigue bien instrucciones de uso de herramientas y de "no afirmes lo que no viene de una herramienta", y responde en español con tablas limpias. Haiku sería más barato; lo dejé como alternativa por variable de entorno.
- **Cambio de proveedor:** `src/llm/openai.ts` implementa la misma interfaz `enviar(mensajes, herramientas)`. Con `LLM_PROVIDER=openai` el ciclo no cambia.
- **Costo por caso (medido en prueba real con `claude-sonnet-5-5`):**

  | Caso | Tokens totales de la sesión |
  |---|---|
  | sol-001 (crea directo) | 24.346 |
  | sol-003 (bloqueo) | 16.829 |
  | sol-004 (dos turnos: pregunta + "confirmo") | 41.668 |

  Casi todo es entrada, porque el historial y los resultados de herramientas se reenvían en cada iteración. Con los precios publicados (USD 2 por millón de entrada, USD 10 por millón de salida) da **aprox. USD 0,04–0,06 por caso simple y USD 0,10 por caso con confirmación**. La respuesta de `/api/chat` trae `tokensSesion` para medirlo en vivo. Bajarlo: caché de prompt para el system prompt y las definiciones de herramientas, o enviar al modelo un resumen de `oc_leer_paquete` en vez del texto completo de la cotización.

## 5. Matriz de controles

Todas las reglas viven en `src/domain/controles.ts` y se ejecutan en `oc_validar`; `oc_construir_payload` y `oc_crear` las vuelven a ejecutar desde los archivos, así que el modelo no puede saltárselas.

| Regla | Tipo | Implementación | Caso que la dispara |
|---|---|---|---|
| RC1 | Bloqueo | Busca por NIT normalizado (sin puntos ni dígito de verificación); sin NIT, por nombre normalizado (sin tildes, espacios ni puntuación). Exige `activo`. | `sol-002`: NIT 901999000 no existe. `sol-006` no trae NIT y se encuentra por nombre. |
| RC2 | Bloqueo | Aprobación presente, contiene "Aprobado" (y no "no aprobado"), y el remitente está en `aprobadores` del centro. La acción sugerida lista quién sí puede aprobar. | `sol-003`: Felipe Vargas aprueba CC-2020 pero es aprobador de CC-3030. |
| RC3 | Bloqueo | `valor_total ≤ tope` del aprobador. Solo se evalúa si RC2 pasó. | En `sol-003` se informa además que nadie en CC-2020 cubre 74 M (Rocío Torres: tope 30 M). |
| RC4 | Bloqueo | Centro existe y la subárea está en su lista. | Ninguno de los 6 casos falla. |
| RC5 | Confirmación | `abs(cot − sol) / sol > 2 %` o sin cotización. Devuelve ambos valores y el porcentaje. | `sol-004`: 25.000.000 vs 26.500.000 (6 %). |
| RC6 | Confirmación + derivado | Sin `indicador_iva` → default del proveedor. | `sol-006`: se propone C1. |
| RC7 | Derivado | Sin `condiciones_pago` → default del proveedor; solo se informa. | `sol-006`: Z030. |
| RC8 | Confirmación | Factura con fecha < `fecha_solicitud` → `retroactiva = true`, se escribe en `out/control.csv`. | `sol-005`: factura del 10-ago, solicitud del 27-ago. |
| RC9 | Confirmación | Fecha (local del remitente) de la aprobación ≥ fecha de solicitud. | Ninguno de los 6 casos falla. |
| RC10 | Bloqueo | `abs(cantidad × valor_unitario − valor_total) ≤ 1`. | Ninguno de los 6 casos falla. |

**La más difícil: RC2/RC3.** No por el código sino por el mensaje: en `sol-003` decir solo "aprobador inválido" no ayuda a la analista. La herramienta explica que Felipe es aprobador de otro centro y que ninguno de CC-2020 tiene tope para 74 M, así que la acción correcta es escalar, no reenviar el correo a Rocío.

### Resultado de `node demo.ts`

| Caso | Esperado (PRD) | Obtenido | ¿Coincide? |
|---|---|---|---|
| sol-001 | OC creada sin intervención | OC 4500000001 | ✔ |
| sol-002 | Bloqueo, proveedor inexistente | Bloqueo RC1, sin OC | ✔ |
| sol-003 | Bloqueo, aprobador sin autoridad | Bloqueo RC2, sin OC | ✔ |
| sol-004 | Confirmación antes de crear | Confirmación RC5 → OC 4500000002 tras confirmar | ✔ |
| sol-005 | Solo con confirmación, `retroactiva = true` | Confirmación RC8, `retroactiva=true` → OC 4500000003 | ✔ |
| sol-006 | Confirmación antes de crear (IVA) | Confirmación RC6 (C1 derivado) → OC 4500000004 | ✔ |
| sol-001 otra vez | Mismo número | 4500000001, `idempotente=true` | ✔ |

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (o su versión 4 en S/4HANA) **detrás de SAP Integration Suite** si la empresa ya lo tiene; si no, directo al gateway OData.

Por qué: es la API estándar y publicada para crear OC, trabaja en JSON sobre HTTPS (encaja con TypeScript sin conectores nativos), soporta autenticación moderna y se puede probar en sandbox. `BAPI_PO_CREATE1` por RFC exige librerías nativas (node-rfc / NW RFC SDK) y acceso de red al sistema; la dejo como alternativa si el SAP es ECC sin gateway.

**Mapeo del payload (7.4 → OData):**

| Payload | OData `A_PurchaseOrder` / `A_PurchaseOrderItem` |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespondenceExternalReference` (o campo Z) — clave de idempotencia |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `descripcion` | `PurchaseOrderItemText` (40) |
| `cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` (UN→EA, H→H según tabla de unidades) |
| `precio_unitario` | `NetPriceAmount` (ojo: SAP espera neto; hoy el valor viene con IVA incluido, hay que dividir por 1+tasa del indicador) |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = K` |
| `subarea` | Campo de imputación según configuración (orden interna o campo Z) |
| Evidencia | Adjunto vía `API_CV_ATTACHMENT_SRV` sobre el documento creado |

**Autenticación y credenciales:** OAuth 2.0 client credentials (Integration Suite) o usuario técnico con certificado X.509. Las credenciales viven en un gestor de secretos (Azure Key Vault / variables cifradas del hosting) y las lee solo el adaptador. El agente, el prompt y el modelo nunca las ven: el modelo llama `oc_crear` y el adaptador hace el resto.

**Idempotencia y errores parciales:**
- Antes de crear: `buscarOrdenPorReferencia` consulta OC por `CorrespondenceExternalReference = solicitud_id`. Si existe, devuelve ese número.
- Creación en una sola llamada profunda (cabecera + posiciones + imputación) para que SAP la confirme o la rechace completa.
- Si la creación pasa pero falla el adjunto: la OC queda registrada, el control marca `evidencia_pendiente` y un reintento solo sube el adjunto.
- Timeout sin respuesta: no se reintenta a ciegas; primero se consulta por referencia.
- Errores de negocio de SAP (proveedor bloqueado, período cerrado) se devuelven como `{ ok: false, error }` legibles.

**Plan B si la conexión no es viable:** el agente hace todo igual hasta el payload validado y, en lugar de crear, genera (a) un resumen listo para copiar campo por campo en ME21N y (b) un archivo de carga masiva (CSV para LSMW o la plantilla de "Migrate Your Data") con la evidencia adjunta. La analista deja de validar y buscar datos y solo carga; el log de control y la medición de retroactivas funcionan igual. Para cambiarlo basta con implementar `SapAdapter` con `crearOrden` que escriba el archivo.

## 7. Lectura del proceso: OC retroactivas

Para la dirección, en corto:

- Una OC retroactiva no es un error de la analista, es una señal de que **la compra ocurrió sin control previo**: el proveedor entregó y facturó antes de que existiera solicitud, cotización comparada y aprobación. En `sol-005` la factura es del 10 de agosto y la solicitud del 27; la aprobación de Rocío Torres dice "ya llegó la factura, por favor crear la OC para poder radicarla". La aprobación existe, pero se dio sobre un hecho cumplido.
- **Riesgo:** se pierde la negociación (no se comparan cotizaciones), el tope de aprobación pierde sentido (aprobar algo ya comprado) y se compromete gasto sin presupuesto reservado.
- **Qué medimos ya:** cada intento queda en `out/control.csv` con `retroactiva`. Con eso se saca el porcentaje por centro de costo, aprobador y proveedor. Recomiendo revisarlo mensual.
- **Cambio de proceso que propongo:**
  1. Regla "sin OC no hay pago" (*no PO, no pay*) comunicada a proveedores: la factura sin número de OC se devuelve.
  2. Para gastos recurrentes de bajo valor (papelería, como `sol-005`), OC abiertas o contratos marco trimestrales: se crea una vez y las facturas se cargan contra ella. Así desaparece la mayoría de retroactivas sin fricción.
  3. Mientras tanto, tolerarlas con marca y exigir que la confirmación la haga alguien distinto a quien aprobó.
- La decisión de tolerarlas o rechazarlas es de la dirección; el agente ya entrega la medición para tomarla.

## 8. Decisiones y trade-offs

1. **Las herramientas releen los archivos en cada llamada** en vez de confiar en el `paquete` / `payload` que manda el modelo. Alternativa descartada: pasar el objeto del modelo a la siguiente herramienta (como sugiere el contrato). Riesgo de que el modelo "arregle" un monto (riesgo explícito del PRD). Costo: lecturas de disco repetidas, que son insignificantes. Los argumentos se aceptan por compatibilidad con el contrato y, en `oc_crear`, el payload enviado se compara con el reconstruido: si difiere, se rechaza.
2. **La confirmación la interpreta el servidor con reglas simples**, no el modelo. Alternativa descartada: dejar que el modelo decida si "ok, pero revisa" es un sí. Es más predecible y auditable; costo: frases ambiguas se tratan como "otro" y el agente vuelve a preguntar.
3. **Node 22 con TypeScript nativo (type stripping) y `node:http`**, sin Express ni build. Alternativa descartada: Express/Hono + tsx. Menos dependencias (solo `zod` y `pdf-lib`), arranque en segundos y mismo código en Bun. Costo: no puedo usar `enum` ni sintaxis TS no borrable.
4. **Front en HTML plano sin streaming.** Alternativa descartada: React con SSE. Ahorra tiempo y el PRD lo permite; costo: el usuario ve "pensando…" hasta que termina el turno, no los pasos en vivo (los ve todos al final del turno).
5. **`oc_crear` también se llama en casos bloqueados y pendientes** para que el intento quede en `control.csv` (HU-5 pide registrar cada intento). Alternativa: registrar desde `oc_validar`. Descartada porque validar no es un intento de crear y duplicaría filas.
6. **Sesiones en memoria** con copia en `out/sesiones/`. Si Render reinicia, se pierden las conversaciones abiertas; para un reto sin base de datos es aceptable.

## 9. Supuestos

- La fecha de aprobación se compara con su fecha local tal como la escribe el remitente (`2026-08-26T18:45-05:00` → `2026-08-26`).
- El NIT de la cotización trae dígito de verificación (`900.555.111-2`); el maestro no. Se comparan sin él.
- Unidad: si la descripción dice "horas" → `H`; en otro caso `UN`. `MES` no se usa en los casos (en `sol-001` "12 meses" es la vigencia, no la cantidad).
- Descripción de la posición recortada a 40 caracteres; el texto completo queda en `trazabilidad.json`.
- `precio_unitario` se toma de la solicitud (IVA incluido, como viene la cotización). En SAP real se calcularía el neto (sección 6).
- En `sol-004` la OC se crea por el valor de la solicitud (lo aprobado), no por el de la cotización. La confirmación lo deja explícito.
- Si la solicitud trae indicador de IVA o condición de pago, no se valida que existan en el maestro porque el PRD no lo pide como regla; sí se usan los maestros para describir los derivados.
- "Aprobado" se busca como palabra completa e ignora "no aprobado".
- El correo de aprobación es evidencia suficiente (PRD).

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx` y PDF reales (P1, no hecho). |
| HU-2 Validar | Hecho (RC1–RC10) | Maestros en vivo desde SAP. |
| HU-3 Payload + trazabilidad | Hecho | Mapeo a OData y cálculo de precio neto. |
| HU-4 Evidencia | Hecho (txt P0 y pdf P1) | Adjuntar a la OC real; firma digital si auditoría la exige. |
| HU-5 Crear OC | Hecho (mock, idempotente, control.csv) | Adaptador real (sección 6). |
| HU-6 Errores | Hecho (`{ ok:false, error }`, JSON malformado, montos no numéricos, adjuntos faltantes) | Pruebas con paquetes corruptos reales. |
| Front de chat | Hecho | Streaming y autenticación de usuarios. |
| Agente con modelo real | Probado con `claude-sonnet-5-5`, los 6 casos: sol-001 crea; sol-002 bloquea por RC1; sol-003 bloquea por RC2; sol-004 pregunta y crea tras "confirmo" (también en la URL pública); sol-005 pide confirmación y marca retroactiva; sol-006 pide confirmar el IVA derivado | Evaluación sistemática de respuestas del modelo (más casos y variaciones de redacción). |
| Link público | Hecho: https://reto-03-periferia.onrender.com (Render, plan gratuito) | Plan pago o despliegue corporativo para evitar que se duerma y para disco persistente. |
| Bonus `modulo/` | Hecho | Se regenera con `npm run modulo` desde las mismas fuentes. |

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic), en sesión agéntica, para leer el PRD y los fixtures, proponer la arquitectura, escribir el código, las pruebas, `demo.ts` y este documento, ejecutar las verificaciones y corregir errores.
- **Qué descarté de lo propuesto o considerado:**
  - Confiar en el `paquete` y el `payload` que envía el modelo entre herramientas: descartado por el riesgo de montos alterados (decisión 1).
  - Dejar que el modelo decida si el usuario confirmó: descartado (decisión 2).
  - Un adaptador de "modelo falso" dentro de la app para demostrar el chat sin clave: descartado porque presentaría respuestas programadas como si fueran un agente. Solo existe en `tests/`, marcado como prueba.
- **Revisión humana:**revisé que los resultados de los 6 casos coincidieran con el PRD, probé el chat con el modelo real y en la URL pública, configuré el despliegue en Render y el límite de gasto, y revisé las reglas RC1–RC10 contra la sección 7.3 del PRD._

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La integración con SAP no es viable pronto | Plan B: archivo de carga masiva y resumen para ME21N (sección 6). |
| El modelo inventa o altera valores | Las herramientas son la única fuente; `oc_crear` reconstruye y compara el payload; prompt con regla explícita. |
| Gasto descontrolado de la clave | Topes de iteraciones y tokens por sesión y globales, clave de acceso al link, límite de tamaño del mensaje. |
| Maestros desactualizados | Consultar proveedor y matriz de aprobación en SAP en tiempo real (`consultarProveedor` ya está en la interfaz). |
| Cotizaciones en PDF con formatos distintos | Parser por proveedor o extracción con el modelo + validación zod, siempre con confirmación humana si falla. |
| Confirmación ambigua o hecha por la persona equivocada | Autenticación y registro de quién confirma; separar quien aprueba de quien confirma retroactivas. |
| Datos sensibles en logs | Los logs guardan argumentos y resúmenes, no la clave; en producción, retención y enmascarado de correos. |
| Pérdida de `out/` en el hosting gratuito | En producción, almacenamiento persistente o la propia SAP como registro. |
