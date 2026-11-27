# Contrato HTTP para la app móvil

La columna «Permiso móvil» describe el contrato de destino. El turno con
conflicto, la lectura de estado por ID y la publicación de ambas firmas
corresponden a #14. Los [casos ejecutables](../pruebas/contrato/README.md)
cubren el contrato de movimientos y la autorización por rol.

## Rutas

Los cuerpos de escritura se envían como `application/json`. Las lecturas JSON
devuelven `200`, salvo los errores descritos abajo. Los ID de movimiento son
enteros y las fechas de creación y firma son cadenas ISO 8601 en UTC.

| Método y ruta | Permiso móvil | Cuerpo y respuesta |
| --- | --- | --- |
| `GET /api/salud` | Comprobación de dirección y servicio, pública si se habilita | Sin cuerpo. Devuelve `{"ok":true}`. |
| `GET /api/declaraciones` | Operación | Sin cuerpo. Objeto con cadenas para `ENTREGA`, `DEVOLUCION` y `CAMBIO`. |
| `GET /api/entregas-pendientes` | Operación | Sin cuerpo. Lista de recepciones firmadas con al menos una herramienta pendiente, de más reciente a más antigua. Cada movimiento añade `pendientes` (lista de líneas). |
| `GET /api/historial` | Administración | Sin cuerpo. `{grupos, sueltas}`, descrito abajo. |
| `GET /api/movimientos` | Administración | Sin cuerpo. Hasta 200 movimientos sin cancelar, por ID descendente. |
| `GET /api/entregas/:id/pdf` | Administración | Sin cuerpo. PDF adjunto del grupo de la recepción, con nombre `<codigo>.pdf`. La búsqueda actual abarca las últimas 1.000 recepciones sin cancelar. |
| `GET /api/export.xlsx` | Administración | Sin cuerpo. XLSX adjunto `Registro_Firmas_YYYY-MM-DD.xlsx`, con las hojas Registro de Firmas e Informe Diario. La hoja de firmas filtra después de obtener los 1.000 movimientos más recientes sin cancelar. El informe parte de hasta 1.000 grupos. |
| `GET /firmas/:archivo` | Administración con acceso al registro | Sin cuerpo. PNG de una URL relativa devuelta por la API. |
| `GET /api/activo` | Operación y tablet vinculada | Sin cuerpo. Movimiento en espera o `null`. La tablet recibe el movimiento únicamente si está asignado a ella, con `Cache-Control: no-store`. |
| `POST /api/movimientos` | Operación | Alta descrita abajo. `201` con el movimiento en estado `esperando`. En #14, `409` si hay un activo. Hoy una nueva alta válida cancela el anterior. |
| `GET /api/movimientos/:id/estado` | Operación y tablet autorizada para ese movimiento | Sin cuerpo. `{id, codigo, estado, firmado_en}`, incluso si ya salió del activo. `firmado_en` es `null` mientras falte la firma. Pendiente de #14, con permisos de #13. |
| `POST /api/movimientos/:id/firmar` | Tablet autorizada para el movimiento | `{firmaEmpleado, firmaResponsable}`, dos cadenas data URL `data:image/png;base64,...`. `200` con el movimiento firmado. Hoy la del responsable es opcional y el servidor decodifica sin comprobar el formato de imagen. |
| `POST /api/movimientos/:id/cancelar` | Operación | Sin cuerpo. `200` y `{"ok":true}`. Solo cambia el ID indicado si está esperando. Hoy también devuelve éxito y emite un aviso si no modificó ninguna fila. |
| `GET /api/eventos` | Sesiones autorizadas en LAN durante la transición | Sin cuerpo. SSE `text/event-stream`, con `latido` (`{}`) cada 8 s, `activo` (movimiento o `null`) y `firmado`. En modo roles, administración recibe avisos sin contenido y operación recibe el activo y un resumen de la firma. Android usa sondeo. |
| `POST /api/dispositivos/codigos` | Administración | Sin cuerpo. `201` con `{dispositivoId, codigo, caduca}`. `409 DISPOSITIVO_OCUPADO` si ya hay una tablet vinculada o un código vigente. |
| `POST /api/dispositivos/vincular` | Equipo en provisión con código de un solo uso | `{"codigo":"..."}` y `200` con `{dispositivoId, credencial}`. Un código vencido, consumido o desconocido devuelve `401`. Un exceso de solicitudes devuelve `429` con `Retry-After`. |
| `GET /api/dispositivos/sesion` | Operación y tablet vinculada | Sin cuerpo. `200` con `{dispositivoId, rol}`. En operación, `dispositivoId` es `null`. |
| `POST /api/dispositivos/:id/revocar` | Administración | Sin cuerpo. `200` con `{"ok":true}`. Acepta el ID entregado al emitir el código. |

## Identidad y provisión

- En el panel, Cloudflare Access gestiona el inicio de sesión del navegador y
  envía `Cf-Access-Jwt-Assertion` al origen. Express valida el JWT firmado,
  su emisor, audiencia y caducidad. El correo de la identidad debe estar
  autorizado para uno de los dos roles humanos.
- En Android, operación envía su JWT individual de Access en
  `Authorization: Bearer <jwt>`. La obtención y renovación del JWT desde
  Android dependen de la integración con el proveedor de identidad del piloto.
  El servidor devuelve `rol: "operacion"` para una identidad autorizada.
- Administración emite un código al preparar la tablet. El código distingue
  mayúsculas de minúsculas, tiene 16 caracteres base64url y dura 10 minutos.
  Escanearlo o introducirlo en ajustes protegidos. Android guarda la
  credencial devuelta usando la protección de Android Keystore y envía
  `Authorization: Bearer <credencial>`. La sesión devuelve `rol: "tablet"`.
- Se admite una sola tablet vinculada. Sus movimientos son los creados desde
  la vinculación, incluso tras reiniciar. Vincular antes de abrir el primer turno.
  Si se pierde la respuesta de vinculación o se reemplaza el equipo, revocar el
  ID entregado al emitir el código y emitir otro. Si queda un movimiento en
  espera asignado a la tablet anterior, operación lo cancela y vuelve a crearlo.
- Con `ACCESO_MODO=legado` y `CLAVE_ACCESO`, el cliente de contingencia usa
  `POST /entrar` con `{clave}` y recibe la cookie anterior. Definir solo
  `CLAVE_ACCESO` también selecciona ese modo para los Compose anteriores.
  Sin esa variable, el modo por defecto es `roles`.

## Túnel con nombre

`docker-compose.tunel-fijo.yml` usa un túnel administrado desde Cloudflare
y retira la publicación del puerto de origen del Compose base. Requiere una
versión de Compose con soporte para `!reset`. [Referencia de Docker Compose](https://docs.docker.com/reference/compose-file/merge/#reset-value).

Configurar fuera del repositorio `CLOUDFLARE_TUNNEL_TOKEN`, los hostnames
`HOST_PANEL` y `HOST_MOVIL`, `ACCESS_EMISOR` (origen HTTPS del equipo
Cloudflare Access), `ACCESS_AUDIENCIA` (AUD de la aplicación del panel),
`ACCESS_ADMINISTRADORES` y `ACCESS_OPERADORES` (listas de correos separados
por comas). Configurar Access en el panel con el proveedor corporativo y
preservar el encabezado `Host` original hacia Express.
[Validación de JWT de Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

En las rutas publicadas del túnel, dirigir el panel protegido y el hostname
móvil a `http://firmas:3000`. En el hostname móvil, publicar únicamente las
rutas de salud, vinculación, sesión y operaciones móviles indicadas en la
tabla. Configurar un límite de intentos por cliente en el borde para la
vinculación y desactivar la caché de la aplicación en ambos hosts. El límite
local de vinculación es de 12 solicitudes por minuto para todo el proceso.
[Enrutamiento de Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/).

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
