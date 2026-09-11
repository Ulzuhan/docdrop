# React assets are built with Node; only the Go binary reaches the runtime.

FROM node:22-alpine AS assets
WORKDIR /app
# Playwright es dependencia de desarrollo y su instalación baja navegadores.
# Aquí no se usan y no deben aparecer ni en esta capa intermedia.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
# `npm ci` completo: vite, Tailwind y PostCSS son dependencias de desarrollo, y
# sin ellas no hay nada que compilar. Nada de esto llega al runtime.
RUN npm ci
# postcss.config.mjs NO es opcional. Sin él, vite copia el CSS SIN PROCESAR y la
# construcción no falla: la imagen sale con la página rota y todo en verde. Pasó
# en SecretDrop, y por eso el recorrido de navegador comprueba un estilo
# calculado contra esta imagen y no sólo que el CSS responda 200.
COPY vite.config.mts postcss.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npx vite build

FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
# Los assets vienen de la etapa anterior y NUNCA del host: `internal/web/dist`
# está en .dockerignore para que un `vite build` local no decida qué se embebe.
COPY --from=assets /app/internal/web/dist ./internal/web/dist
# CGO fuera: aquí no hay dependencias nativas —el almacén es el árbol de
# ficheros de siempre, no una base— así que el binario sale estático.
# -trimpath deja las rutas de compilación fuera, que es lo que permite
# reconstruirlo igual desde otro directorio.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/docdrop ./cmd/docdrop

FROM alpine:3.24 AS runtime
ENV HOSTNAME=0.0.0.0 PORT=3010 DOCDROP_DATA_DIR=/data
# Alpine con CA y shell: la shell la usa el `command` del compose para cargar el
# fichero de entorno, y las CA hacen falta para hablar con el proveedor por
# HTTPS.
#
# uid 1001, EL MISMO que llevaba la imagen de Node: los ficheros del volumen de
# datos son suyos, y cambiarlo dejaría el almacén ilegible para el servicio.
RUN apk -U upgrade --no-cache \
 && apk add --no-cache ca-certificates \
 && addgroup -S -g 1001 docdrop && adduser -S -u 1001 -G docdrop docdrop \
 && mkdir /data && chmod 0700 /data && chown docdrop:docdrop /data
# El binario y nada más. La interfaz va embebida con go:embed, así que aquí no
# hay node, ni npm, ni node_modules, ni Playwright, ni navegadores.
COPY --from=build /out/docdrop /usr/local/bin/docdrop
USER docdrop
EXPOSE 3010
# Los ficheros subidos viven fuera de la capa de la imagen, o se perderían en
# cada reemplazo del contenedor.
VOLUME ["/data"]

# La sonda va dentro del binario porque aquí no hay node con el que preguntar.
# Pega a /healthz, que no pasa por el limitador de peticiones ni recorre el
# almacén: la versión de Node usaba /api/info/<id>, que sí consume cupo del
# mismo cubo que el tráfico real cuando no hay proxy delante.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["docdrop", "sonda"]

# Sin start.js: el plazo largo por petición —lo que permite que una subida de
# gigas sea UNA petición de horas— lo pone el propio binario.
CMD ["docdrop"]

LABEL org.opencontainers.image.title="DocDrop" \
      org.opencontainers.image.description="Self-hosted file sharing with expiring links: resumable chunked uploads for multi-GB files, previews and streamed ZIP downloads" \
      org.opencontainers.image.source="https://github.com/Ulzuhan/docdrop" \
      org.opencontainers.image.licenses="MIT"
