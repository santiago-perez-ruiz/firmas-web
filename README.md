# Pantalla de firma — Entrega y Devolución de Herramientas

Aplicación web para que el empleado firme con el dedo o el lápiz digital en una tablet.
El almacenista arma el movimiento desde su equipo y lo **activa**; la tablet solo muestra
lo activado y captura la firma. La tablet no tiene ningún campo de texto, así que **el
teclado nunca aparece**.

## Las tres pantallas

| Ruta         | Quién la usa | Para qué |
|--------------|--------------|----------|
| `/`          | Almacenista (PC) | Arma la ENTREGA y la envía a la tablet |
| `/firmar`    | Tablet       | Muestra el movimiento activo y captura las dos firmas |
| `/registros` | Almacenista (PC) | Histórico agrupado por entrega, con las firmas, y descarga a Excel |

El envío a la tablet es instantáneo (Server-Sent Events); no hay que refrescar nada.
Solo puede haber **un movimiento activo a la vez**: enviar uno nuevo cancela el anterior.

## Flujo de firma en la tablet

1. El almacenista arma el movimiento. Una ENTREGA se escribe en `/`: empleado y
   herramientas. Una DEVOLUCIÓN no se escribe: se abre su entrega en `/registros` y
   se pulsa **Gestionar entrega**, que muestra lo que sigue fuera para marcar qué
   vuelve y en qué estado. En ambos casos se envía a la tablet.
2. La tablet pasa sola de "Esperando" a la pantalla del movimiento, en verde si es
   ENTREGA y en ámbar si es DEVOLUCIÓN, con la lista de herramientas y la declaración.
3. **Paso 1** — firma el empleado. **Borrar** rehace el trazo, **Confirmar firma** avanza.
4. **Paso 2** — firma el almacenista.
5. Se guarda, la tablet muestra "Firma registrada" y vuelve a reposo a los 4 segundos.

## Arranque con Docker

```bash
cd firmas-web
docker compose up -d --build
```

- Operador: `http://localhost:8090/`
- Tablet:   `http://<IP-del-servidor>:8090/firmar`

El puerto del equipo es el `8090` (dentro del contenedor sigue siendo el 3000). Si lo
necesita en otro, cambie solo el numero de la izquierda en `docker-compose.yml`.

Para saber qué IP poner en la tablet, en el servidor Windows:

```powershell
ipconfig | Select-String IPv4
```

La tablet debe estar en la misma red que el servidor. Conviene fijar la IP del servidor
en el router para que la dirección no cambie.

### Sin Docker

```bash
npm install
npm start
```

## Publicar en internet con Cloudflare

El túnel sale desde el contenedor hacia Cloudflare, así que **no hay que abrir puertos
en el router ni exponer la IP de la empresa**. La tablet puede entonces firmar desde
cualquier red, no solo desde la wifi de la planta.

### URL temporal (para compartir o probar)

```bash
docker compose -f docker-compose.yml -f docker-compose.tunel.yml up -d
docker logs firmas-tunel | grep trycloudflare
```

La última línea muestra la URL asignada. **Cambia cada vez que se reinicia el
contenedor del túnel**, así que sirve para enseñar la aplicación o para una prueba,
no para dejarla puesta en la tablet.

### URL fija (para uso diario)

Necesita una cuenta de Cloudflare con un dominio:

1. En *Cloudflare Zero Trust → Networks → Tunnels*, cree un túnel y copie su token.
2. Póngalo en `.env` como `CLOUDFLARE_TUNNEL_TOKEN=...`
3. En el panel del túnel, apunte el hostname público a `http://firmas:3000`.
4. `docker compose -f docker-compose.yml -f docker-compose.tunel-fijo.yml up -d`

Sobre esto se puede activar **Cloudflare Access** para exigir correo corporativo antes
de llegar siquiera a la aplicación.

## Código de acceso

`CLAVE_ACCESO` en el archivo `.env` protege toda la aplicación. Los túneles la exigen:
sin ella el `docker compose` se niega a arrancar, porque `/registros` muestra nombres y
cédulas y una URL pública la puede abrir cualquiera.

- La pantalla de entrada es un **teclado numérico en pantalla**, así que la tablet
  tampoco necesita el teclado del sistema para escribir el código.
- La sesión dura 30 días en una cookie: la tablet se identifica una vez y ya.
- Ocho intentos fallidos por IP en diez minutos y esa IP queda frenada.
- Cambiar la clave caduca todas las sesiones abiertas.

Sin `CLAVE_ACCESO` la aplicación queda abierta, que es lo razonable dentro de la red
interna. Al publicarla, deja de serlo.

### Antes de dejarla publicada

- Cambie el código por uno propio en `.env` y reinicie (`docker compose ... up -d`).
- Un código de 6 dígitos frena a un curioso, no a un atacante con tiempo. Para uso
  serio, ponga Cloudflare Access encima del túnel fijo.
- La URL temporal es pública: quien la tenga solo necesita el código.

## Aviso sobre los avisos en vivo

Dentro de la red local, el envío a la tablet llega por Server-Sent Events en unos
milisegundos. **A través del túnel de Cloudflare no**: el proxy retiene el flujo y no
entrega nada (comprobado; ni siquiera con relleno inicial de 2 KB).

Por eso el canal se vigila solo: el servidor manda un latido cada 8 segundos y, si el
navegador no recibe nada en 14, pasa a preguntar por el movimiento activo cada 3
segundos. La pantalla de firma sigue funcionando igual, con unos segundos de retraso en
vez de al instante, y lo indica abajo como "Conectado (modo consulta periódica)".
Cuando el flujo vuelve a llegar, se apaga el sondeo solo.

## La devolución está atada a la entrega

Una DEVOLUCIÓN no se escribe a mano: **se abre desde su entrega**. En `/registros` se
entra en el registro y se pulsa **Gestionar entrega**; ahí aparece lo que sigue fuera,
ya marcado, y de la entrega salen solos el nombre, la cédula y el departamento. Lo único
que se registra a mano es **en qué estado regresa cada herramienta**, que es el dato que
la devolución aporta.

Por eso la pantalla del operador no pregunta el tipo de movimiento: solo arma entregas.
Una devolución sin entrega detrás no existe, así que empezarla desde el registro de esa
entrega es el único camino que no se puede recorrer mal.

Cada herramienta de una entrega lleva un número interno. Una devolución guarda los
números de las que regresan, así que:

- **Devoluciones parciales**: si de tres herramientas vuelven dos, la entrega sigue
  apareciendo como pendiente con la tercera. Se cierra sola cuando vuelve la última.
- **No se puede devolver dos veces** la misma herramienta: el servidor la rechaza
  porque ya no figura entre las pendientes.
- **No se puede devolver algo que nunca se entregó**, ni registrar una devolución
  suelta sin entrega: también se rechaza.
- La condición con la que salió y la condición con la que volvió quedan **las dos**
  guardadas, en la entrega y en la devolución respectivamente.

Qué sigue en la calle no se guarda en ningún campo: **se calcula** a partir de las
devoluciones firmadas. Así no hay dos versiones de la verdad que se puedan
desincronizar, por ejemplo si una devolución se cancela antes de firmarse. Una
devolución solo cuenta cuando está firmada.

La pantalla de registros muestra arriba cuántas herramientas están sin devolver y de
quién, y el Excel trae una columna *Devuelve la Entrega* con el vínculo.

El histórico es una **lista con una fila por entrega**, no por movimiento: cada fila es
un ID con su devolución asociada dentro, y dice cuántas herramientas han vuelto de
cuántas. Al entrar en una fila se ve el detalle — qué herramienta cerró cada devolución
y las firmas de las dos partes. Las firmas se muestran **encuadradas al trazo**, porque
el PNG guarda todo el ancho del lienzo de la tablet y sin encuadrar la miniatura es
ilegible; un clic la abre a tamaño completo. El archivo en disco no se toca: el encuadre
es solo CSS, y al Excel sigue yendo la imagen entera.

### Nota sobre cantidades

Una línea de herramienta se devuelve entera. Si se entregaron "2 × pinza" y vuelve una
sola, hoy no se puede registrar media línea: conviene entregarlas como dos líneas
separadas si se van a devolver por separado.

## Datos y respaldo

Todo vive en `./data`, montado como volumen en `/datos`:

- `firmas.db` — base SQLite con los movimientos y el vínculo entrega ↔ devolución
- `firmas/` — un PNG por firma (`<id>-empleado.png`, `<id>-responsable.png`)

**Respaldar esa carpeta es respaldar todo el registro.** Copiarla con el contenedor
detenido (`docker compose stop`) evita copiar la base a medio escribir.

## PDF de un registro

Dentro del detalle de un registro, **Descargar PDF** genera el comprobante de esa
transacción: los datos del empleado, las herramientas con lo que ya volvió y lo que no,
y las firmas de la entrega y de cada devolución. Es lo que se archiva en papel o se le
entrega al empleado.

El botón de Excel no aparece ahí, y el de PDF no aparece en la lista: son cosas
distintas. El Excel es el histórico completo; el PDF, una sola transacción.

## Excel

`/registros` → **Descargar Excel** genera un `.xlsx` con una fila por movimiento y
**las firmas incrustadas como imagen dentro de la celda**, en el mismo formato de la
hoja "Control Diario" de los formularios originales. Sirve como respaldo imprimible y
archivable; el registro vivo es la base de datos.

**Las firmas llenan su celda.** El PNG se guarda recortado al trazo desde la propia
tablet, así que en el Excel la firma ocupa la celda entera en vez de ser un garabato
perdido en un lienzo transparente. Conserva su proporción: no se estira.

**Las firmas no se pueden mover.** Una imagen en Excel es normalmente un objeto
flotante que se arrastra con el ratón, y una firma movida de fila queda atribuida a otra
persona. Por eso la hoja sale protegida con los objetos bloqueados. El resto de la hoja
sigue siendo normal: se puede escribir, ordenar, filtrar e imprimir, porque las celdas
van desbloqueadas. Si alguna vez hiciera falta mover una firma, en Excel se quita la
protección con *Revisar → Desproteger hoja* (no tiene contraseña).

## Poner la tablet en modo quiosco

En Android hay una vía mejor que las de esta sección: **`../firmas-android/`** compila un
APK que envuelve esta misma web. Llega ya sin barra de direcciones, guarda la dirección
del servidor —de modo que un cambio de túnel se arregla en la tablet sin recompilar— y
evita que girarla borre una firma a medio hacer, que es lo que ocurre con un acceso
directo del navegador. Los pasos de abajo siguen valiendo para el iPad, o si se prefiere
no instalar nada.

Para que el operario solo pueda firmar y no navegar a otro lado:

- **Android**: Chrome → abrir `/firmar` → menú → *Agregar a pantalla principal*. Se abre
  a pantalla completa sin barra de direcciones. Para bloquearla en esa app, usar
  *Ajustes → Seguridad → Fijar aplicación*.
- **iPad**: Safari → *Compartir* → *Agregar a pantalla de inicio*. Bloquear con
  *Ajustes → Accesibilidad → Acceso guiado*.

Conviene además desactivar el bloqueo de pantalla por inactividad en la tablet. Si aun
así se duerme, al despertar la pantalla se resincroniza sola.

## Variables de entorno

| Variable                  | Por defecto | Para qué |
|---------------------------|-------------|----------|
| `PORT`                    | `3000`      | Puerto del servidor |
| `DATA_DIR`                | `/datos`    | Dónde viven la base y los PNG |
| `TZ`                      | —           | Zona horaria de las fechas (`America/Bogota` en el compose) |
| `CLAVE_ACCESO`            | vacío       | Código de entrada. Vacío = abierto. Obligatorio con túnel |
| `CLOUDFLARE_TUNNEL_TOKEN` | vacío       | Token del túnel fijo (solo `docker-compose.tunel-fijo.yml`) |

Se definen en el archivo `.env` junto al `docker-compose.yml`. Hay una plantilla en
`.env.ejemplo`. **El `.env` no se sube a git ni entra en la imagen**: lleva el código.

## Notas técnicas

- El lienzo usa **Pointer Events**, así que dedo, lápiz digital y mouse van por el mismo
  camino. `touch-action: none` evita que arrastrar el dedo desplace la página.
- El trazo se suaviza con curvas cuadráticas entre puntos medios consecutivos y usa
  `getCoalescedEvents()` para recuperar los puntos que el navegador agrupa: sin eso, una
  firma rápida sale poligonal.
- El lienzo se reescala con `ResizeObserver`, de modo que rotar la tablet no descuadra
  el trazo respecto del dedo.
- Las firmas se guardan como PNG con **fondo transparente**, listas para incrustar sobre
  cualquier fondo en Excel.
- No hay dependencias de CDN: la app funciona en una red sin salida a internet.
