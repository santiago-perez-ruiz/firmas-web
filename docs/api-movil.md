# Contrato HTTP para la app móvil

La columna «Permiso móvil» describe el contrato de destino. Las identidades, la
vinculación, la revocación y los filtros por rol quedan pendientes de #13. El
turno con conflicto, la lectura por ID y la publicación de ambas firmas quedan
pendientes de #14. Los [casos ejecutables](../pruebas/contrato/README.md) fijan el
comportamiento disponible en el servidor de #12.

## Rutas

Los cuerpos de escritura se envían como `application/json`. Las lecturas JSON
devuelven `200`, salvo los errores descritos abajo. Los ID de movimiento son
enteros y las fechas de creación y firma son cadenas ISO 8601 en UTC.

| Método y ruta | Permiso móvil | Cuerpo y respuesta |
| --- | --- | --- |
| `GET /api/salud` | Comprobación de dirección y servicio, pública si se habilita | Sin cuerpo. Exponer como máximo `{"ok":true}` al público. Hoy también devuelve `conectados` (número de conexiones SSE). |
| `GET /api/declaraciones` | Operación | Sin cuerpo. Objeto con cadenas para `ENTREGA`, `DEVOLUCION` y `CAMBIO`. |
| `GET /api/entregas-pendientes` | Operación | Sin cuerpo. Lista de recepciones firmadas con al menos una herramienta pendiente, de más reciente a más antigua. Cada movimiento añade `pendientes` (lista de líneas). |
| `GET /api/historial` | Administración | Sin cuerpo. `{grupos, sueltas}`, descrito abajo. |
| `GET /api/movimientos` | Administración | Sin cuerpo. Hasta 200 movimientos sin cancelar, por ID descendente. |
| `GET /api/entregas/:id/pdf` | Administración | Sin cuerpo. PDF adjunto del grupo de la recepción, con nombre `<codigo>.pdf`. Consulta por ID de recepción sin cancelar y devuelve `404` si el grupo no existe. |
| `GET /api/export.xlsx` | Administración | Sin cuerpo. XLSX adjunto `Registro_Firmas_YYYY-MM-DD.xlsx`, con las hojas Registro de Firmas e Informe Diario. La hoja de firmas incluye todos los movimientos firmados. El informe calcula las herramientas de todos los grupos de recepciones firmadas. |
| `GET /firmas/:archivo` | Administración con acceso al registro | Sin cuerpo. PNG de una URL relativa devuelta por la API. |
| `GET /api/activo` | Operación y tablet vinculada | Sin cuerpo. Movimiento en espera o `null`. La tablet recibe el movimiento únicamente si está asignado a ella, con `Cache-Control: no-store` (#13 y #14). Hoy cualquier sesión con acceso obtiene el movimiento completo. |
| `POST /api/movimientos` | Operación | Alta descrita abajo. `201` con el movimiento en estado `esperando`. En #14, `409` si hay un activo. Hoy una nueva alta válida cancela el anterior. |
| `GET /api/movimientos/:id/estado` | Operación y tablet autorizada para ese movimiento | Sin cuerpo. `{id, codigo, estado, firmado_en}`, incluso si ya salió del activo. `firmado_en` es `null` mientras falte la firma. Pendiente de #14, con permisos de #13. |
| `POST /api/movimientos/:id/firmar` | Tablet autorizada para el movimiento | `{firmaEmpleado, firmaResponsable}`, dos cadenas data URL `data:image/png;base64,...`. `200` con el movimiento firmado. Hoy la del responsable es opcional y el servidor decodifica sin comprobar el formato de imagen. |
| `POST /api/movimientos/:id/cancelar` | Operación | Sin cuerpo. `200` y `{"ok":true}`. Solo cambia el ID indicado si está esperando. Hoy también devuelve éxito y emite un aviso si no modificó ninguna fila. |
| `GET /api/eventos` | Sesiones autorizadas en LAN durante la transición | Sin cuerpo. SSE `text/event-stream`, con `latido` (`{}`) cada 8 s, `activo` (movimiento o `null`) y `firmado` (movimiento). Si se conserva, filtrar por rol y tratar cada aviso como señal para consultar. |
| `POST /api/dispositivos/vincular` | Equipo en provisión con código de un solo uso | Propuesta para #13. `{"codigo":"..."}` y `200` con `{dispositivoId, credencial}`. La credencial es revocable y se guarda con protección de Android Keystore. |
| `GET /api/dispositivos/sesion` | Sesión móvil autenticada | Ruta propuesta para #13. Sin cuerpo. `200` con `{dispositivoId, rol}` para comprobar acceso tras probar la dirección con salud. |

Para las dos rutas de provisión, los nombres de campos y la forma de presentar la
credencial quedan por confirmar en #13. Operación requiere además identidad
individual. Administración usa identidad corporativa con Cloudflare Access.
Hoy, con clave compartida configurada, `POST /entrar` acepta `{clave}` y devuelve
`{ok:true}` y la cookie de sesión. Una API sin sesión recibe `401` y los
estáticos redirigen a `/entrar`. Salud queda pública. Sin clave el servidor
actual permite todas las rutas disponibles.

## Alta y representación de movimientos

| Tipo | Campos de entrada |
| --- | --- |
| `ENTREGA` (recepción) | `tipo`, `modo` (`rapida` o `detallada`), `empleado` y una o más `herramientas` con `descripcion` no vacía. Enviar `cedula`, `departamento`, `responsable` y `observaciones` generales según lo completado. Cada línea admite `cantidad` (cadena, por defecto `"1"`), `estado` y `observaciones`. La detallada admite `codigoEmpleado` y `declaracion` editable. |
| `DEVOLUCION` | `tipo`, `entregaId` de una recepción firmada, `responsable`, `observaciones` y una o más `herramientas` con `id` pendiente, `estado` de regreso y `observaciones` de línea. |
| `CAMBIO` | Mismos campos de cabecera que devolución. Incluir al menos una línea con `sentido: "devuelve"` y los campos de devolución, y al menos una con `sentido: "recibe"`, `descripcion`, `cantidad`, `estado` y `observaciones`. |

El servidor asigna código anual `TRX` o `TRXD` según el modo y numera las líneas
de recepción desde 1. El modo omitido se normaliza a `rapida`. Una declaración
vacía usa el texto por tipo. La detallada ofrece Excelente, Bueno, Regular y
Mantenimiento. Estos valores son del formulario, el servidor almacena el texto
de estado de la línea.

La devolución y el cambio heredan empleado, cédula, departamento, ficha y modo.
Cada línea que vuelve conserva descripción y cantidad originales. La unidad que
regresa es la línea completa. Los ID salientes deben pertenecer a las pendientes
y ser únicos en la solicitud. Hoy CAMBIO rechaza duplicados, mientras que
DEVOLUCION los admite dentro de una misma alta. La validación uniforme queda
pendiente de #14. Las líneas nuevas de cambio reciben ID por encima del máximo
del grupo, incluidos los cambios cancelados.

Un movimiento completo contiene:

- `id`, `codigo`, `tipo`, `modo`, `empleado`, `cedula`, `departamento`,
  `codigo_empleado`, `responsable`, `observaciones`, `declaracion`.
- `herramientas`, arreglo con `id`, `descripcion`, `cantidad`, `estado` y
  `observaciones`. Las líneas de CAMBIO llevan además `sentido`. Los registros
  antiguos pueden omitir propiedades de línea.
- `estado` (`esperando`, `firmado` o `cancelado`), `creado_en`, `firmado_en`
  (fecha o `null`), `entrega_id` y `entregaCodigo` (ID y código de la recepción
  vinculada, o `null`).
- `firma_empleado`, `firma_responsable` (nombres de archivo o `null`) y
  `firmaEmpleadoUrl`, `firmaResponsableUrl` (rutas relativas o `null`). El
  acceso a los PNG depende del permiso de administración (#13).

En historial, cada grupo tiene `{entrega, devoluciones, pendientes, ciclo}`.
Hay hasta 200 grupos de recepciones sin cancelar, ordenados por ID descendente.
El panel consulta `GET /api/historial?completo=1` para obtener todos los grupos
con el mismo orden y el indicador booleano `operacionWeb`.
`devoluciones` agrupa devoluciones y cambios sin cancelar por ID ascendente,
incluidos los que esperan firma. `sueltas` conserva los registros antiguos sin
recepción vinculada. `entrega.herramientas` incluye las incorporadas en cambios
firmados. Cada línea indica `devuelta` (booleano), `devueltaEn`, `devueltaFecha`,
`cerradaPor` (`DEVOLUCION`, `CAMBIO` o `null`), `llegoEn` y `llegoFecha`.
Los campos de origen y cierre usan código y fecha de firma o `null`. Los
pendientes se calculan con los cambios y devoluciones firmados. `ciclo` vale
`esperando`, `sin-devolver`, `parcial` o `completa`.

## Errores y reintentos

Formato móvil acordado para el cliente. `codigo` permite decidir qué hacer
y `error` contiene el mensaje en español, compatible con la lectura del
cliente web durante la transición. Ejemplo de conflicto:

```json
{"codigo":"MOVIMIENTO_ACTIVO","error":"Ya hay un movimiento esperando firma"}
```

| HTTP | Código estable | Cuándo y cómo proceder |
| --- | --- | --- |
| 400 | `VALIDACION` | Cuerpo, ID o PNG inválido. Corregir el dato antes de enviar otra vez. En #14 se comprueban ambas imágenes y su tamaño antes de confirmar. Hoy el límite general del parser JSON es 8 MB. |
| 401 | `SESION_REQUERIDA` | Falta sesión válida, caducó o fue revocada. Recuperar acceso autorizado y reconciliar las escrituras inciertas antes de repetir. |
| 403 | `PERMISO_DENEGADO` | El rol o la asignación impiden la operación. Resolver el permiso o la asignación. |
| 404 | `NO_ENCONTRADO` | ID o recurso inexistente dentro del alcance autorizado. Actualizar la consulta. |
| 409 | `MOVIMIENTO_ACTIVO` | Ya hay un turno ocupado. Conservar el borrador y consultar el activo. Esperar a que se resuelva o cancelar por ID con confirmación. |
| 409 | `ESTADO_INCOMPATIBLE` | Firma o cancelación incompatible con el estado del movimiento. Consultar el estado por ID y usar el resultado definitivo. |

Los códigos estables y la normalización de errores corresponden a #13 y #14
según la ruta. Hoy los manejadores de escritura y el PDF devuelven `400`
con `{error}` incluso en varios conflictos o ID ausentes. Rutas ausentes y
errores del parser pueden devolver HTML.

- Las lecturas y descargas se pueden repetir. Para el activo, consultar al
  abrir, despertar o recuperar conexión y cada 3 s en primer plano. Mantener
  una consulta en vuelo, aplicar tiempo límite y aumentar la espera tras fallos.
  Conservar los trazos al recibir el mismo ID. SSE es opcional para el sondeo.
- Tras un alta con respuesta perdida, consultar el activo y mostrarlo al
  operador. Si falta o no coincide, usar el historial reciente cuando esté
  autorizado y verificar con la tablet. Exigir confirmación antes de otra alta.
  Un alta sin ID conocido carece de reconciliación unívoca. El contrato inicial
  no incluye reintentos automáticos ni claves de idempotencia.
- Tras firmar o cancelar con respuesta perdida, consultar el estado por ID
  (#14). Si ya está firmado o cancelado, mostrar el estado definitivo. Si
  sigue esperando, confirmar que es el turno correcto y repetir la acción
  sobre ese mismo ID. Conservar ambas firmas hasta confirmar el resultado.
- Si se pierde la respuesta de vinculación, comprobar la sesión si la credencial
  llegó a guardarse. Si no se puede autenticar y el código ya fue consumido,
  solicitar otra provisión mediante el flujo de #13.
