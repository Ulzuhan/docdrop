# Despliegue y operación

DocDrop debe ejecutarse como **una sola instancia** detrás de un proxy TLS. La reserva de cuota, la serialización del contador de descargas, los límites de frecuencia y el estado de reanudación de transferencias son locales al proceso; varias réplicas compartiendo el mismo volumen romperían esas garantías. El proxy debe reemplazar (no anexar) `X-Forwarded-For`.

## Docker Compose

1. Copia `.env.example` a `.env`, genera `DOCDROP_SESSION_SECRET` con `openssl rand -hex 32` (mínimo 32 bytes; con menos, el arranque falla cerrado) y configura OIDC con URLs HTTPS públicas — basta `DOCDROP_OIDC_ISSUER`, porque el resto de endpoints se leen del discovery del proveedor. Añade `DOCDROP_ENROLL_URL` con el flujo de alta de tu proveedor: es el botón «Request an account» de la portada y sin ella no aparece — que es lo correcto si tu proveedor no tiene alta autoservicio.
2. Ejecuta `docker compose up -d --build`.
3. Publica únicamente el proxy HTTPS; Compose enlaza la aplicación a `127.0.0.1:3010`. El propio `compose.yaml` trae comentado el servicio de túnel que permite quitar el bloque `ports:` entero.

Desde la 3.0.0 la imagen **no lleva Node**: es un binario de Go con la interfaz embebida, corre como uid 1001 y pesa unos 26 MB. El arranque es el propio binario; si venías de una versión anterior con `command: [... exec node start.js]`, hay que cambiarlo por `exec docdrop`.

El contenedor corre sin root y con un volumen persistente en `/data`. Los límites predeterminados son 10 GB por fichero y 20 GB en total (`DOCDROP_MAX_FILE_BYTES`, `DOCDROP_MAX_TOTAL_BYTES`); la tabla completa de variables está en el README. HTTPS no es opcional en la práctica: el cifrado en el navegador, el service worker de la descarga en flujo y la verificación de integridad de trozos usan APIs que solo existen en contextos seguros.

## Datos, copias y recuperación

**No hagas copias de seguridad de `/data`.** Los ficheros prometen caducar y autodestruirse, y una copia que sobreviva a la caducidad convierte la promesa en decoración. Desde la 2.0.0 la política falla a salvo dos veces: lo subido nuevo es un criptograma cuya llave viaja en el fragmento del enlace y nunca llega al servidor, así que una copia sin llaves es ilegible — pero los metadatos y los ficheros de antes del cifrado sí serían legibles, y la razón de fondo (la caducidad) no cambia.

El directorio de datos también contiene las fichas locales de usuario y los enlaces de invitado. El servidor barre cada hora ficheros caducados, agotados y subidas abandonadas; una descarga agotada deja una lápida siete días para poder responder «max downloads reached» en vez de un 404 ambiguo. Supervisa espacio libre, reinicios del servicio y fallos de la limpieza — y avisa antes de que el sistema de ficheros del volumen se acerque al lleno, porque la cuota acota lo almacenado pero no protege al resto del disco.

Evita logs de URL completos y no añadas analítica de terceros: la llave nunca llega en la petición (los navegadores no envían el fragmento), pero los ids de descarga son capacidades de 72 bits y un log que los recoja es una lista de puertas.

## Lo que se le exige al proxy de delante

- **`X-Forwarded-For` debe llegar con la dirección real al final.** El límite de
  peticiones toma el último valor, no el primero, y eso es deliberado: el primero lo
  escribe quien llama. `X-Real-Ip` no se usa a propósito — verificado en vivo que el
  túnel lo deja pasar intacto, así que quien llama podría inventarse una por petición.
  **Expuesta sin proxy, la limitación sí se esquiva**: de ahí que la aplicación deba
  escuchar solo en loopback o en la red interna de contenedores.
- **`Host` debe traer el nombre público.** La reconstrucción de origen lo usa a él y
  no a `X-Forwarded-Host`, porque esa segunda **el túnel de Cloudflare no la
  reemplaza** — verificado en vivo. Si el proxy reescribe `Host` con un nombre
  interno, hay que poner `DOCDROP_PUBLIC_HOST`.
- **Sin topes de cuerpo por petición que rompan los trozos**: la subida troceada envía
  partes de 32 MiB (`DOCDROP_CHUNK_BYTES`); el tope del borde debe quedar por encima.

## Identidad y rotación

Las sesiones firmadas duran 12 horas por defecto (máximo 24). El proveedor puede cerrarlas antes con su aviso de cierre de sesión (back-channel), que anota a esa persona en `revocaciones.json` y hace que sus cookies dejen de valer en la siguiente petición; sin aviso, el tope es la caducidad de la cookie. Borrar la cuenta en el proveedor no basta por sí solo, pero borrar su ficha del almacén sí: la sesión busca al usuario en disco en cada petición. Rota `DOCDROP_SESSION_SECRET` para invalidar todas a la vez. Guarda los secretos OIDC fuera de la imagen y restringe la lectura del fichero `.env`.

## Parada, y qué pasa con una transferencia en curso

Al recibir la señal de parada el servicio **cierra la admisión**, deja un margen corto a lo que esté a punto de terminar y después **corta** las transferencias en curso de forma controlada. No las espera, y no puede: una subida de varios gigas dura horas y ninguna ventana de parada razonable la cubre.

Cortar no pierde nada. Una subida troceada continúa por los trozos que falten y una descarga continúa por rango. Lo que sí está garantizado es que una transferencia cortada deja el almacén como si no hubiera existido: la descarga **no cuenta**, suelta su plaza contra el límite, el trozo a medias **no queda marcado** como recibido, y la reserva de espacio se libera. Hay regresiones deterministas para los cuatro casos.

El presupuesto total es de 8 segundos (`DOCDROP_SHUTDOWN_MS`) y cabe dentro de los 10 que concede Docker por defecto. Si se alarga `stop_grace_period`, hay que alargar también esa variable; al revés, acortar el margen del contenedor sin acortar el presupuesto deja al servicio sin tiempo de soltar lo que tiene puesto.

## Antes de actualizar

```bash
npm ci
npm run lint && npx tsc --noEmit && npx vitest run
go vet ./cmd/... ./internal/... && go test -race ./cmd/... ./internal/...
npm run build:web && go build -o docdrop ./cmd/docdrop
DOCDROP_TEST_LAUNCH=./docdrop DOCDROP_TEST_BUILD_STAMP=./docdrop ./scripts/run-suites.sh
DOCDROP_TEST_LAUNCH=./docdrop bash scripts/test-backchannel.sh
DOCDROP_TEST_LAUNCH=./docdrop npm run test:navegador
scripts/test-compatibilidad.sh          # contra el digest exacto de vuelta atrás
```

No despliegues si algo falla. El modelo de amenaza completo y sus verificaciones están en [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

## Vuelta atrás

El retorno es la imagen de Node **2.3.1** (`Dockerfile.node` construye la misma). Se para el servicio, se vuelve al digest y al comando anteriores **sobre el árbol de datos actual**, y se arranca. `scripts/test-compatibilidad.sh` comprueba exactamente ese camino —Node publicado → Go → el mismo Node, por turnos, sin escritores simultáneos— y verifica que lo que Go agotó sigue agotado y lo caducado sigue caducado.

**Restaurar una copia no es una vuelta atrás.** Perdería lo subido después y, peor, resucitaría ficheros que alguien ya retiró y contadores ya gastados: en un servicio cuyo producto es «esto se borra solo», eso es peor que el fallo que se intentaba arreglar. Si el estado estuviera corrupto, se aísla y se decide la recuperación explícitamente.
