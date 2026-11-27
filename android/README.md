# Firmas para Android

La aplicación requiere Android 8.0 o posterior. `app` aloja la actividad y
los ajustes, `almacen` contiene la operación del almacenista y `comun`
contiene los modelos y el cliente HTTP compartidos.

## Compilar el APK de depuración

Desde `android/`, con Docker Compose:

```sh
docker compose -f docker-compose.apk.yml run --rm --build apk
```

Con Java 17, Gradle 8.7 y el SDK de Android 34 instalados, ejecutar
`./construir.sh`. Ambos caminos usan la firma de depuración de Android y dejan
el APK en `salida/firmas-almacen-debug.apk`.

## Configurar y operar

En el primer arranque, indicar la URL base del servidor y comprobar el
acceso. La dirección queda guardada en el dispositivo. El campo de credencial
es opcional y envía un token Bearer únicamente por HTTPS. La credencial se
mantiene en memoria. La vinculación y la identidad del operador requieren
acordar la integración con #13. El piloto trabaja con un turno global para una
tablet y los catálogos del formulario actual.

La versión de depuración admite HTTP en `10.0.2.2` (servidor local desde el
emulador) y `127.0.0.1`. La versión normal requiere HTTPS.

Mientras un movimiento está esperando firma se puede seguir editando el
borrador. El botón de envío se habilita después de comprobar que el turno
está libre. Ante un conflicto se consulta el activo y el borrador sigue
abierto. Cuando se pierde la respuesta de un alta, el operador debe verificar
su resultado y confirmar antes de repetir. Se conserva esa obligación
aunque se cierre el proceso. Los borradores se mantienen en memoria durante
la rotación y al cambiar de pestaña.

Gestionar recepción toma las líneas pendientes de SQLite a través del
servidor. Cada devolución selecciona líneas completas. Para las recepciones detalladas también se puede registrar un cambio con
las herramientas nuevas. La cancelación pide confirmar el
código del movimiento activo y se envía para su ID.

El servidor de transición carece de la ruta de estado por ID. En ese caso se
consulta el listado de movimientos para recuperar una firma reciente. Una
cancelación no aparece en ese listado y su estado queda por confirmar. La
protección frente a dos altas concurrentes y la reconciliación definitiva por
ID requieren #14.

## Preparar una tablet de firma

1. En la pantalla de servidor de Almacén, elige **Configurar modo Firma**.
   Indica la URL base HTTPS o importa una imagen con un QR que contenga
   únicamente esa URL. En una tablet gestionada, el administrador puede
   fijar la dirección con la configuración de app `servidor_https`.
2. Solicita a administración el código de vinculación de un solo uso.
   Introdúcelo y crea un PIN local de soporte de 6 a 12 dígitos. La app
   comprueba salud y sesión de tablet antes de guardar la dirección y cifra
   la credencial con Android Keystore. Al cambiar de origen pide otro código.
3. Autoriza el paquete `co.firmas.piloto` para Lock Task desde el controlador
   de políticas de Android. Si el equipo carece de gestión, acepta la
   fijación de pantalla cuando Android la pida. El piloto usa una tablet
   vinculada y un turno global.

En modo Firma se revisan el resumen y la declaración, y se firman ambos
pasos. La app sondea por HTTPS en primer plano cada tres segundos, aumenta
la espera hasta treinta segundos cuando falla la consulta y vuelve a
consultar al recuperar la conexión. Al enviar conserva las dos firmas
hasta comprobar el resultado por ID. Si el proceso se cierra mientras
se dibuja, al volver avisa y pide capturar de nuevo si el turno sigue pendiente.

Para abrir soporte mantén tres dedos sobre la pantalla durante tres
segundos e introduce el PIN. Los ajustes y la salida a Almacén quedan
detrás de este acceso. Para seleccionar una imagen QR, la app sale
temporalmente de Lock Task tras autenticar a soporte y lo vuelve a pedir
al regresar a Firma. **Volver** conserva la dirección y las firmas en curso.
Una dirección administrada nueva requiere comprobarla y vincular el equipo
antes de aplicarla.

Para el piloto de Firma se necesitan la vinculación de #13 y la consulta de
estado y el guardado de ambos PNG de #14.

## Pruebas

Desde `android/`, `gradle :comun:test` ejecuta las pruebas JVM con HTTP
simulado. Desde la raíz del repositorio, con las dependencias Node instaladas:

```sh
npm test
FIRMAS_GRADLE_PRUEBAS="$(command -v gradle)" npm test
```

La segunda ejecución añade una prueba del cliente Kotlin con el servidor
local en un puerto efímero y una base SQLite temporal. Usa movimientos y
firmas sintéticos. Requiere Java 17 y el SDK de Android 34 para configurar el
proyecto Gradle.
