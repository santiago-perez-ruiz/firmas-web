# Firmas Almacén para Android

La aplicación requiere Android 8.0 o posterior. `app` aloja la actividad y
los ajustes, `almacen` contiene la operación del almacenista y `comun`
contiene los modelos y el cliente HTTP que puede reutilizar un módulo de Firma.

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
