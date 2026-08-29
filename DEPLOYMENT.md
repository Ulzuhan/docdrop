# Despliegue y operación

DocDrop debe ejecutarse como **una sola instancia** detrás de un proxy TLS. La reserva de cuota, la serialización del contador de descargas, los límites de frecuencia y el estado de reanudación de transferencias son locales al proceso; varias réplicas compartiendo el mismo volumen romperían esas garantías. El proxy debe reemplazar (no anexar) `X-Forwarded-For`.

## Docker Compose

1. Copia `.env.example` a `.env`, genera `DOCDROP_SESSION_SECRET` con `openssl rand -hex 32` (mínimo 32 bytes; con menos, el arranque falla cerrado) y configura OIDC con URLs HTTPS públicas — basta `DOCDROP_OIDC_ISSUER`, porque el resto de endpoints se leen del discovery del proveedor. Añade `DOCDROP_ENROLL_URL` con el flujo de alta de tu proveedor: es el botón «Request an account» de la portada y sin ella no aparece — que es lo correcto si tu proveedor no tiene alta autoservicio.
2. Ejecuta `docker compose up -d --build`.
3. Publica únicamente el proxy HTTPS; Compose enlaza la aplicación a `127.0.0.1:3010`. El propio `compose.yaml` trae comentado el servicio de túnel que permite quitar el bloque `ports:` entero.

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

Las sesiones firmadas duran 12 horas por defecto (máximo 24) y no tienen revocación local; deshabilitar una cuenta en el proveedor no invalida inmediatamente una cookie ya emitida. Rota `DOCDROP_SESSION_SECRET` para invalidar todas las sesiones a la vez. Guarda los secretos OIDC fuera de la imagen y restringe la lectura del fichero `.env`.

Antes de actualizar ejecuta `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm run build` y `npm test`. No despliegues si algo falla. El modelo de amenaza completo y sus verificaciones están en [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).
