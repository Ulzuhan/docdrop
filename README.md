# DocDrop

Compartir ficheros grandes con un enlace temporal, sin comprimir y sin depender de
servicios de terceros. Alguien sube un vídeo, pasa el enlace, y quien lo quiera se lo
descarga. El fichero se borra solo al caducar o al agotar sus descargas.

El caso que dio origen a todo: estar de viaje, grabar con una GoPro y pasar el vídeo
de 7 GB entre móviles y ordenadores **sin que WhatsApp o Telegram lo recompriman**.

- Next.js 16 (App Router) · React 19 · Tailwind v4 · shadcn/ui
- Sin base de datos: los ficheros y sus metadatos viven en disco
- PWA instalable, con soporte del menú "Compartir" de Android
- Subida de varios ficheros o carpetas enteras, por trozos y reanudable
- Previsualización de vídeo, audio e imagen antes de descargar
- Descarga de varios ficheros juntos en un ZIP, sin comprimir y por streaming

---

## Cómo se usa

```bash
npm install
npm run build            # compila y prepara la salida standalone
PORT=3456 npm run start  # arranca en http://127.0.0.1:3456
```

> **Arráncalo siempre con `npm run start`, nunca con `next start`.**
>
> `npm run start` ejecuta `scripts/start.js`, que ajusta el `requestTimeout` del
> servidor HTTP antes de ceder el control a Next (ver
> [Muro 2](#muro-2--el-límite-de-5-minutos-de-node)). Arrancar con `npx next start`
> reintroduce el corte a los 5 minutos: las subidas grandes vuelven a morir a media
> transferencia. Además `next start` es incompatible con `output: standalone`.

El puerto sale de `PORT` (3010 si no se indica). El bot de Telegram que levanta la
aplicación a demanda usa el **3456**.

Para desarrollo, `npm run dev` funciona con normalidad.

### Acceso desde fuera

El servicio escucha **solo en 127.0.0.1**. Para llegar a él desde el móvil o desde
fuera de casa hay dos vías:

```bash
# Túnel público temporal (se cierra con Ctrl-C)
cloudflared tunnel --url http://127.0.0.1:3456

# Solo para los dispositivos de tu tailnet
tailscale serve --bg --https=8454 http://127.0.0.1:3456
```

Ambas dan HTTPS, que hace falta para instalar la PWA y para que funcione lo de
"Compartir" desde la galería.

### Dejarlo corriendo

`npm run start` muere al cerrar la terminal. El túnel puede levantarse y cerrarse a
demanda, pero **el servicio tiene que estar arriba** para que el túnel sirva algo. Sin
recurrir a systemd de sistema, lo más cómodo es un servicio de usuario:

```bash
# ~/.config/systemd/user/docdrop.service
[Unit]
Description=DocDrop
[Service]
WorkingDirectory=%h/proyectos-desarrollo/web/nextjs/docdrop
ExecStart=/usr/local/bin/node scripts/start.js
Environment=PORT=3456
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now docdrop
sudo loginctl enable-linger "$USER"   # que siga vivo sin sesión abierta
```

Alternativa rápida y sin ceremonia: `tmux new -s docdrop 'npm run start'`.

Para aislarlo de verdad del resto del sistema hay una unidad de systemd endurecida en
[`deploy/`](deploy/README.md), pero requiere root y es opcional.

---

## Modelo de acceso

Por defecto arranca **abierto**: quien llegue al servicio puede subir y ver la lista
completa de ficheros. Es lo razonable en red privada o tras un túnel que se abre y se
cierra a mano, pero conviene tenerlo presente: mientras el túnel esté levantado,
cualquiera con esa URL tiene acceso de escritura.

Poniendo una contraseña, el reparto pasa a ser:

| Ruta | Con contraseña configurada |
|---|---|
| `/`, `/api/upload*`, `/api/files*`, `/api/cleanup` | Requiere sesión |
| `/d/[id]`, `/api/info/[id]`, `/api/download/[id]` | Público (el secreto es el id de 72 bits) |

Así se comparte un fichero con alguien de fuera sin darle credenciales.

```bash
npm run set-password              # o: npm run set-password 'mi contraseña'
# pega las dos líneas que imprime en el entorno del proceso y reinicia
```

El modo con el que arranca queda registrado en el log (`[docdrop] modo: ABIERTO` o
`PROTEGIDO`), para que quedarse abierto sea siempre una decisión y no el resultado de
perder un fichero de configuración.

---

## Subidas grandes

Aquí está casi todo el trabajo, porque un fichero de varios GB choca con tres muros
distintos, cada uno con su propio síntoma.

### Muro 1 — la memoria del servidor

La versión original leía el fichero entero en memoria (`request.formData()` al subir,
`readFile()` al descargar). Con el límite anunciado de 10 GB el proceso moría mucho
antes: el tope de `Buffer` en Node ronda los 2 GB.

**Ahora** todo va por streaming en ambos sentidos. Comprobado con un fichero de 3 GB:
sube y baja idéntico byte a byte con la memoria del servidor plana en ~160 MB.

### Muro 2 — el límite de 5 minutos de Node

Node aborta con **408** cualquier petición que dure más de `server.requestTimeout`, y
su valor por defecto son **300 000 ms (5 minutos)**. Como una subida es *una sola*
petición HTTP, un fichero grande se corta a media transferencia: a ~19 MB/s el límite
llega sobre los 5,6 GB, así que un vídeo de 7 GB moría pasado el 80 % sin ningún error
claro.

Reproducido con una subida limitada a 512 KB/s:

```
antes:   http=408  tiempo=306,06 s  subido=160.563.200 de 200.000.000  (76 %)
después: http=200  tiempo=380,79 s  subido=200.000.000                 (100 %)
```

Next solo deja configurar `keepAliveTimeout`, no `requestTimeout`, y su documentación
descarta combinar `output: standalone` con un servidor propio. Por eso
`scripts/start.js` intercepta la creación del servidor HTTP, sube el límite por
petición a 12 h y arranca Next después. `headersTimeout` se queda en 60 s, que es el
que frena a quien manda las cabeceras gota a gota; el cuerpo no puede crecer sin
límite porque `/api/upload` corta al superar el tamaño máximo.

### Muro 3 — el tope por petición de los proxies

Medido contra un quick tunnel de Cloudflare:

| Tamaño en una sola petición | Resultado |
|---|---|
| 500 MiB (524.288.000 B) | HTTP 200 |
| 511,99 MiB | HTTP 413 |
| 512 MiB y más | HTTP 413 **en 0,55 s** |

El rechazo es inmediato: Cloudflare lo corta al leer el `Content-Length`, sin
transferir nada. (La documentación de Cloudflare cita 100 MB para el plan gratuito; el
límite real medido en quick tunnels es 500 MiB.) **Las descargas no tienen ese tope**:
600 MB bajaron por el mismo túnel a 30 MB/s.

### La solución: subida por trozos

El navegador ya no envía una petición gigante. Parte el fichero en trozos de 32 MiB y
manda cada uno por separado. Cada trozo se escribe **directamente en su posición**
dentro del fichero final, así que no hay fase de ensamblado ni se duplica el espacio en
disco. Qué trozos han llegado se registra con ficheros marca vacíos, que son atómicos y
no necesitan bloqueos entre peticiones concurrentes.

```
POST   /api/upload/init             abre la subida → { uploadId, chunkSize, totalParts }
PUT    /api/upload/[id]/part/[n]    envía un trozo (idempotente)
GET    /api/upload/[id]             qué trozos faltan
POST   /api/upload/[id]/complete    cierra y publica el fichero
DELETE /api/upload/[id]             cancela
```

Mientras la subida está en curso, la entrada en disco es así:

```
<id>/file          fichero final, reservado con su tamaño definitivo
<id>/session.json  metadatos de la subida
<id>/parts/<n>     marca de "el trozo n ya está escrito"
```

Al completarse aparece `<id>/meta.json` y desaparecen `session.json` y `parts/`, con lo
que pasa a ser un fichero normal para el resto de la aplicación.

**Reanudación.** El navegador recuerda el identificador de la subida asociado a una
huella del fichero (nombre + tamaño + fecha de modificación). Si la subida se corta
—pantalla bloqueada, salto de wifi a datos, pestaña cerrada— basta con volver a elegir
el mismo fichero: consulta qué trozos faltan y **sigue donde iba** en lugar de
reiniciar. Las sesiones a medias se pueden retomar durante 24 h; después las borra el
barrido de limpieza.

Verificado con el mismo fichero y el mismo túnel:

```
600 MB en una petición  ->  HTTP 413
600 MB en 18 trozos     ->  completado en 46 s, sin fallos
descarga de vuelta      ->  SHA256 idéntico
```

---

## Subir varios a la vez

Se pueden soltar varios ficheros, elegirlos con el selector o arrastrar una carpeta
entera (se recorre en profundidad). La cola sube **de dos en dos**: lanzarlas todas
a la vez reparte el ancho de banda entre muchas conexiones y no termina ninguna, que
con vídeos de varios GB es lo peor posible.

Mientras hay algo subiendo se pide un **Wake Lock** para que la pantalla del móvil no
se apague. Sin eso el sistema suspende la subida al bloquear: no se pierde el
progreso, pero hay que volver a la app y reelegir el fichero.

## Descargar varios en un ZIP

Se marcan varios ficheros en la lista y se bajan de una vez. El ZIP se genera **por
streaming y sin comprimir** (método "store"): lo que se comparte aquí son vídeos y
fotos, que ya vienen comprimidos, así que pasarlos por deflate solo gastaría CPU. Sale
a velocidad de disco y no ocupa espacio temporal en el servidor.

Detalles que importan:

- **ZIP64 cuando hace falta.** Un vídeo de 7 GB no cabe en los campos de 32 bits del
  formato clásico; sin esto el ZIP saldría corrupto justo en el caso para el que
  existe el servicio. Comprobado con un fichero de 4,5 GB: `unzip -t` lo valida y el
  contenido sale intacto, con 250 bytes de sobrecarga.
- **Descriptor de datos**, para no tener que leer cada fichero dos veces ni cargarlo
  en memoria para calcular el CRC por adelantado.
- Los nombres repetidos se renombran dentro del ZIP (`foto.jpg`, `foto (2).jpg`).
- Cada fichero incluido cuenta como una descarga suya. Los que ya no estén
  disponibles se omiten en vez de tumbar el ZIP entero: mejor recibir 9 de 10 vídeos
  que un error.

```
GET /api/zip?ids=a,b,c&name=viaje
```

## Quién sube cada fichero

Cada uno pone su nombre en el panel (se guarda en el navegador) y los ficheros que
suba quedan etiquetados con él en la lista. Es una etiqueta informativa, no una
identidad: el servicio puede estar abierto y cualquiera puede escribir lo que quiera.

## Límite de descargas

Se elige en el panel junto a la caducidad: sin límite, 1, 5 o 20. Al agotarse, el
contenido se borra y el enlace pasa a responder "descargas agotadas". Útil para
mandar algo a una persona concreta y que no quede dando vueltas.

## Integridad

El navegador manda el SHA-256 de cada trozo en `X-Chunk-Sha256` y el servidor lo
verifica antes de darlo por bueno; si no cuadra responde 422 y **no** marca el trozo
como recibido, así que el cliente lo reenvía. Sin esto, con reintentos automáticos de
por medio, un trozo corrupto habría pasado desapercibido: el tamaño cuadraba.

La cabecera es opcional porque `crypto.subtle` solo existe en contextos seguros
(HTTPS o localhost); por IP local en HTTP la subida funciona igual, sin comprobación.

## Pruebas

```bash
PORT=3456 npm run start &
npm run test:upload
```

18 comprobaciones sobre el protocolo de subida: trozos, reanudación, idempotencia,
checksums, índices inválidos y límites. Sin dependencias ni framework — se ejecuta
contra un servidor en marcha y borra lo que crea.

## PWA

Instalable en la pantalla de inicio. El manifiesto declara `share_target`, así que
DocDrop **aparece en el menú "Compartir" del móvil**: se abre la galería, se comparte
el vídeo y se elige DocDrop, sin pasar por el navegador ni buscar el fichero a mano.
El service worker recibe ese POST, guarda el fichero un momento y redirige a la
página, que lo recoge y lo sube.

El service worker **no cachea la aplicación** a propósito: en un servicio propio,
servir una versión vieja desde caché causa más problemas de los que evita.

Los iconos se generan con `node scripts/generate-icons.mjs`, que rasteriza y escribe
el PNG usando solo `zlib` (esta máquina no tiene ImageMagick ni Pillow). Los PNG
resultantes están versionados; solo hay que reejecutarlo si se cambia el diseño.

Requiere HTTPS: por el túnel de Cloudflare o por Tailscale sí, pero por IP local con
HTTP el navegador no permite instalar ni compartir.

---

## API

| Método y ruta | Para qué |
|---|---|
| `POST /api/upload` | Subida en una sola petición (ficheros pequeños) |
| `POST /api/upload/init` | Abre una subida por trozos |
| `PUT /api/upload/[id]/part/[n]` | Envía un trozo |
| `GET /api/upload/[id]` | Estado, para reanudar |
| `POST /api/upload/[id]/complete` | Cierra la subida |
| `DELETE /api/upload/[id]` | Cancela una subida a medias |
| `GET /api/files` | Lista de ficheros activos y ocupación |
| `DELETE /api/files/[id]` | Borra un fichero |
| `GET /api/info/[id]` | Metadatos, sin consumir descarga · **público** |
| `GET /api/download/[id]` | Descarga, admite `Range` · **público** |
| `GET /api/download/[id]?inline=1` | Previsualizar sin consumir descarga · **público** |
| `GET /api/zip?ids=a,b,c` | Varios ficheros en un ZIP · **público** |
| `POST /api/cleanup` | Purga caducados, agotados y subidas abandonadas |
| `POST /api/auth/login` · `/api/auth/logout` | Sesión, si hay contraseña |

---

## Configuración

Todo por variables de entorno; ninguna es obligatoria.

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | 3010 | Puerto de escucha (el bot usa 3456) |
| `DOCDROP_DATA_DIR` | `.docdrop-uploads` | Dónde viven los ficheros |
| `DOCDROP_MAX_FILE_BYTES` | 10 GB | Tamaño máximo por fichero |
| `DOCDROP_MAX_TOTAL_BYTES` | 20 GB | Ocupación total; evita llenar el disco |
| `DOCDROP_CHUNK_BYTES` | 32 MiB | Tamaño de trozo |
| `DOCDROP_REQUEST_TIMEOUT_MS` | 12 h | Duración máxima de una petición |
| `DOCDROP_PASSWORD_HASH` | — | Activa la contraseña del panel |
| `DOCDROP_SESSION_SECRET` | — | Firma de la cookie de sesión |

---

## Seguridad

Pensado para poder quedar expuesto a internet a ratos, detrás de un túnel que no
aporta ni WAF ni filtrado.

- **Cuota total de almacenamiento**, para que nadie llene el disco de la máquina y se
  lleve por delante al resto de servicios.
- **Límite por IP**: 5 intentos de login cada 15 min, 30 subidas/hora, 240
  descargas/min. La IP sale del **último** valor de `X-Forwarded-For`, que el proxy
  sobrescribe. No se usa `X-Real-Ip`: comprobado que Tailscale la deja pasar sin
  filtrar, y el cliente podría inventarla en cada petición para esquivar el límite.
- **Ids validados** antes de tocar el sistema de ficheros: sin eso, un id como
  `../../etc` se salía del directorio de datos.
- **Cabeceras**: CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `nosniff`, y sin `X-Powered-By`.
- Las descargas se sirven siempre como `attachment` con `nosniff`, para que un fichero
  subido no pueda ejecutarse como página en el mismo origen.
- Contraseña guardada solo como hash **scrypt**, comparada en tiempo constante; sesión
  en cookie firmada con HMAC-SHA256, `httpOnly` + `secure` + `sameSite`.

Para correrlo aislado del resto del sistema (usuario propio fuera del grupo `docker`,
sin acceso a `/home`, con topes de memoria), hay una unidad de systemd preparada en
[`deploy/`](deploy/README.md). Es opcional.

---

## Mantenimiento

El servidor **barre el almacén cada hora** por su cuenta (ver `instrumentation-node.ts`):
borra lo caducado, lo agotado y las subidas abandonadas. Antes esto no existía y un
fichero caducado que nadie volviera a abrir se quedaba ocupando cuota para siempre,
hasta que las subidas nuevas empezaban a fallar con "Storage full".

Para forzarlo a mano:

```bash
curl -X POST http://127.0.0.1:3456/api/cleanup
```

Al agotarse las descargas de un fichero se borra su contenido pero se conserva una
lápida durante 7 días, para poder responder "descargas agotadas" en vez de un 404
indistinguible de un enlace mal copiado.

---

## Notas de implementación

Cosas que costaron encontrar y conviene no volver a romper:

- **Una sola fuente de verdad.** Hubo dos cachés en memoria (una a nivel de módulo en
  `/api/upload` y otra en `globalThis` en `/api/download`) que se desincronizaban entre
  sí y con el disco: la lista mostraba contadores de descarga obsoletos. Ahora manda el
  disco y punto.
- **El contador de descargas se serializa por id.** Sin eso, varias descargas
  simultáneas leían el mismo valor y se saltaban el límite.
- **El barrido respeta las subidas en curso.** Antes borraba cualquier directorio sin
  `meta.json` que llevara más de una hora, lo que habría matado una subida de varios GB
  a medias.
- **`Content-Length` sale del fichero real**, no de lo que diga el metadato.
- **`Content-Disposition` usa `filename*`** (RFC 5987) o los nombres con acentos
  llegaban como `informe%20a%CC%81nual.txt`.
- **`serverExternalPackages` no sirve para módulos nativos.** Listaba `fs`, `path` y
  `crypto` "para permitir subidas grandes"; no hacía absolutamente nada.
- **La previsualización solo admite tipos que no ejecutan guiones.** Servir contenido
  subido con `Content-Disposition: inline` en el mismo origen es lo que convierte un
  servicio de ficheros en un XSS almacenado: basta con subir un `.html` o un `.svg`.
  Se permiten vídeo, audio, imagen (menos SVG) y PDF; el resto se fuerza a descarga.
- **Previsualizar no consume descargas**, o abrir la vista previa gastaría el cupo del
  fichero.
- **No se lee `Date.now()` durante el render.** Es impuro y además dejaba las cuentas
  atrás congeladas en el valor que tuvieran al abrir la página.

Este proyecto usa una versión de Next con cambios de convenciones respecto a lo
habitual (`middleware.ts` → `proxy.ts`, `RouteContext<'/ruta'>`, route handlers sin
caché por defecto). Ver `AGENTS.md`: conviene mirar `node_modules/next/dist/docs/`
antes de dar por hecho cómo funciona algo.
