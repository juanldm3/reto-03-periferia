## El proceso de órdenes de compra en Periferia

Cada compra llega a administración por correo con tres piezas: la solicitud (Excel), la cotización del proveedor y el correo de aprobación del líder. Hoy la analista digita en SAP proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta la aprobación en PDF.

En este entorno los adjuntos ya vienen normalizados: `solicitud.json`, `cotizacion.txt`, `aprobacion.json` y, solo en compras retroactivas, `factura.txt`. Cada caso es una carpeta `sol-00X`.

## Reglas de control (las aplica `oc_validar`; aquí se explica su sentido)

| Regla | Qué revisa | Si falla |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo. | Bloqueo. Pedir a datos maestros que lo cree o reactive. |
| RC2 | Hay aprobación, dice "Aprobado" y la envía un aprobador del centro de costo. | Bloqueo. Pedir la aprobación a quien corresponde. |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo. Escalar a un aprobador con tope suficiente. |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo. Pedir corrección al solicitante. |
| RC5 | La cotización difiere de la solicitud en 2 % o menos. Sin cotización también se pregunta. | Confirmación con ambos valores. |
| RC6 | Sin indicador de IVA, se toma el default del proveedor. | Confirmación + valor derivado. |
| RC7 | Sin condiciones de pago, se toman las del proveedor. | Solo se informa (derivado). |
| RC8 | Si hay factura con fecha anterior a la solicitud, la OC es **retroactiva**. | Confirmación; queda `retroactiva = true` en el log. |
| RC9 | La aprobación no puede ser anterior a la solicitud. | Confirmación. |
| RC10 | cantidad × valor unitario = valor total (± 1). | Bloqueo. |

- **Bloqueo**: la OC no se crea. Se devuelve la razón y la acción sugerida.
- **Confirmación**: la OC se crea solo si la analista confirma en el chat.
- **Derivado**: valor completado desde maestros que se debe informar.

## Por qué importan las OC retroactivas

Muchas OC se crean después de que llega la factura, saltándose la cotización. La dirección quiere medir cuántas son. El agente no las rechaza: las marca y las cuenta en `out/control.csv`. La política (tolerarlas o rechazarlas) la decide la dirección.

## Datos del SAP simulado

- Sociedad y organización de compras: "1000".
- Números de OC secuenciales desde 4500000001.
- Crear dos veces la misma solicitud devuelve el número existente.
- Texto breve de la posición: máximo 40 caracteres (límite de SAP); el texto completo queda en la trazabilidad.
- Unidad: "H" si la descripción habla de horas; si no, "UN".
- Evidencia: `out/<caso>/aprobacion.txt` y `.pdf` con sha256.
