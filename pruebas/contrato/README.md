# Pruebas del contrato móvil

Con Node.js 20 o superior, desde la raíz del repositorio:

```sh
npm ci
npm test
```

La suite arranca el servidor de este checkout en procesos propios con puertos
libres asignados por el sistema, únicamente en loopback. Verifica que los
puertos no sean 3000 ni 8090. Cada caso empieza en una carpeta temporal vacía
y configura su propio `DATA_DIR`. El caso histórico carga `antigua.sql` y
genera PNG sintéticos antes de arrancar. La suite detiene los procesos y
elimina sus carpetas temporales al terminar.

| Caso ejecutado | Resultado esperado |
| --- | --- |
| Base vacía y altas simultáneas | Una respuesta 201 y una 409. El ID creado conserva el turno hasta cancelar o firmar. Una firma tardía devuelve 409. Cancelar un ID anterior deja intacto el activo. |
| Validación y firma | Alta sin empleado, firma incompleta y PNG inválido o demasiado grande devuelven 400. Un cuerpo JSON mayor de 8 MiB devuelve 413. La lectura por ID devuelve el estado, incluso después de liberar el turno, y devuelve 404 para un ID desconocido. |
| Recepción rápida y detallada | Series TRX y TRXD independientes. La rápida toma la declaración por defecto; la detallada conserva ficha, declaración e ID de líneas. |
| Devolución parcial y cambio | Se heredan datos de la recepción. Una devolución pendiente de firma no cierra líneas. Los cambios y devoluciones rechazan un ID saliente duplicado. Un cambio cancelado deja los pendientes intactos y su ID incorporado queda reservado. Un cambio firmado incorpora la herramienta, que luego se devuelve por su ID. |
| Historial y archivos | El ciclo se completa y aparecen los orígenes y cierres calculados. Los PNG descargados coinciden con los escritos, el PDF tiene cabecera y nombre de archivo esperados y el Excel abre con las dos hojas e imágenes. |
| Base antigua | La migración numera las herramientas, asigna modo rápido y conserva código, fecha, firmas y devolución suelta. |
| Respaldo y restauración | Con el escritor detenido, se copia toda la carpeta sintética, se restaura en otra ruta y se vuelve a arrancar. Se comparan filas e historial, se comprueban integridad y referencias SQLite y se vuelven a consultar las firmas y exportaciones. |
| Acceso compartido y SSE | Salud pública, API sin sesión con 401 JSON, redirección de la página de firma, acceso con cookie sintética, latido inicial por SSE local y 429 al agotar los intentos de entrada. |
| Fallo y reinicio durante la firma | Un error parcial al escribir el segundo PNG deja el turno en espera y limpia el intento. Un reinicio después del primer renombrado limpia el PNG huérfano y el temporal, conserva ambas firmas previas y permite reintentar. |

## Casos pendientes del contrato móvil

| Issue | Caso y resultado esperado |
| --- | --- |
| #13 | Vincular una tablet una sola vez, verificar sesión y revocar. Probar 401 tras revocación, 403 para roles indebidos, acceso a estáticos, exportaciones y PNG, y ausencia de datos del turno en una tablet ajena. |
| #15 y #16 | Integrar el borrador ante conflicto y el sondeo de la tablet. Probar captura con dedo, rotación, quiosco y recuperación por túnel. |
| #17 | Verificar límites de 200 y 1.000 con volumen sintético, contenido y presentación de las exportaciones y retirada de las vistas operativas en el corte. |
| #18 | Ensayar el respaldo operativo y la reversión en el entorno aislado del piloto. |
