# DocDrop: de Next a React + Go

Plan de trabajo del producto. El plan de infraestructura, con el encaje en el
laboratorio, el despliegue y la vuelta atrás, está en
`kaicorplabs/docs/39-plan-docdrop-react-go.md`.

Objetivo: **sacar Node del contenedor de producción**, conservándolo sólo para
compilar la interfaz y ejecutar pruebas. Nada de funcionalidad se retira, el
diseño no cambia, y **el formato en disco no se toca**: los enlaces ya repartidos
tienen que seguir funcionando, y la imagen 2.3.1 tiene que poder volver a
arrancar sobre los datos que escriba Go.

Base: `main` en `e04a49d`, versión 2.3.1. Imagen de retorno
`ghcr.io/ulzuhan/docdrop:2.3.1@sha256:525ef454305d7455c774d4463d11feb029ba8091ef4b83508a7b4002c19f0f67`.

## Lo que no se puede romper

### El árbol de datos

```text
<DATA>/<id>/file            contenido (bulto cifrado si es E2EE)
<DATA>/<id>/meta.json       ficha
<DATA>/<id>/session.json    subida troceada en curso
<DATA>/<id>/parts/<n>       marcador vacío del trozo n
<DATA>/users/<sha256(sub)>.json
<DATA>/guests/<token>.json
<DATA>/revocaciones.json
```

- Fechas en **milisegundos** (`Date.now()`).
- Opcionales **ausentes** cuando no aplican: `uploadedBy`, `owner`, `encrypted`,
  `burnedAt`, `burnedReason`, `label`, `createdBy`, `name`. `encrypted` sólo con
  valor `true`.
- Numéricos **siempre presentes aunque valgan 0**: `size`, `downloadCount`,
  `maxDownloads`, `uploadCount`. Con `omitempty`, el Node de vuelta atrás lee
  `undefined`, hace `undefined++` → `NaN`, lo escribe como `null` y el límite de
  descargas deja de existir. Hay regresión para esto en los dos sentidos.
- `meta.json` y `revocaciones.json` se escriben con temporal + `rename`; la
  segunda con permisos `0600`.
- El blob de una subida troceada se preasigna al tamaño final y se escribe por
  desplazamiento. Es lo que hace que la cuota lo vea desde el principio.
- `users` y `guests` no casan con `^[0-9a-f]{12,64}$`, y por eso los recorredores
  del almacén los ignoran. No crear directorios nuevos con nombre hexadecimal.

### La contabilidad

- Una descarga cuenta **al entregar el último byte**, no al pedirla.
- Mientras está en vuelo ocupa plaza contra el límite (TTL 2 h); la plaza se
  suelta en la misma sección crítica que confirma el contador.
- Las continuaciones por `Range` son gratis **sólo** para un cliente que ya pagó
  una descarga completa (clave `id\0cliente`, TTL 1 h, apuntada después de
  contabilizar). Mandar `Range` no da derecho a nada.
- La vista previa (`?inline=1` y tipo seguro) ni cuenta ni registra continuación.
- La cuota se reserva bajo candado, se transfiere **fuera** del candado y se
  suelta siempre. Sostenerlo durante la transferencia serializa el servicio.
- Plazas, continuaciones y reservas viven en memoria y se pierden al reiniciar:
  es correcto, nada se cuenta de más. No persistirlas.

### El cifrado

`src/lib/e2ee.ts` se queda **tal cual** en el navegador. No se porta a Go, no se
duplica. Lo único que el servidor toca de un bulto es el prefijo en claro (magia,
tamaño de trozo, longitud de cabecera) para devolver la cabecera cifrada en
`/api/info/<id>`. El servidor no ve una clave nunca, por ninguna vía.

### Las transferencias

- Nunca cargar un fichero en memoria. El contenedor tiene 1 GiB y el límite por
  fichero son 10 GB.
- Trozo corto ⇒ 400 sin marcar. Hash que no cuadra ⇒ 422 sin marcar. Ese «sin
  marcar» es lo que hace segura la reanudación.
- Tener acceso y ser dueño de *una subida concreta* son cosas distintas: sin esa
  comprobación, dos enlaces de invitado se pisaban los trozos. Ajeno ⇒ 404.
- Sin `WriteTimeout` global en el servidor HTTP: cortaría las descargas largas.

## Estructura

```text
cmd/docdrop/         arranque, configuración, señales, parada, healthcheck
internal/httpapi/    rutas, páginas, CSP/cabeceras, límites, origen
internal/auth/       OIDC, cookies firmadas, usuarios, revocaciones
internal/store/      meta, blobs, cuota, plazas, continuaciones, barrido
internal/uploads/    sesiones troceadas
internal/web/        HTML mínimo + go:embed de los assets compilados
web/src/             React/TypeScript, mismo diseño, E2EE intacto
scripts/             suites compartidas Node↔Go y compatibilidad
```

## Parada

El contenedor concede 10 s y una subida puede durar horas: **no se drena, se
corta bien**. Cerrar admisión → cancelar las transferencias en curso de forma
controlada → cada una deja el almacén como si no hubiera existido (la descarga
no cuenta y suelta plaza, el trozo no se marca, la reserva se libera) → parar el
barrido → cerrar el almacén. Presupuesto total inyectable, 8 s por defecto,
repartido en plazos que suman **dentro** del total.

## Correcciones que entran con su regresión

1. `exp` obligatorio y finito en el `logout_token` (hoy sólo se valida si viene).
2. `sid` sin `sub` deja de responder 200 sin haber revocado nada.
3. `cleanupSessions` no puede borrar una entrada que ya tiene `meta.json`: si
   `completeSession` falla al retirar `session.json`, el barrido hace `rm -rf` de
   un fichero válido 24 h después. Debe limitarse a retirar `session.json` y
   `parts/`.
4. `GET /api/zip` acepta bultos cifrados. El panel **ya** los excluye —casilla
   deshabilitada y con su motivo—, así que no es un defecto que se vea usando el
   producto; lo que queda abierto es la URL a mano, que empaqueta ciphertext
   inservible y gasta una descarga de cada uno. Se rechaza con un motivo.
5. El healthcheck deja de usar `/api/info/<id>`, que pasa por el limitador de
   peticiones y comparte cupo con el tráfico real.

## Entregas

- **DD-1** — `DOCDROP_TEST_LAUNCH` y `DOCDROP_TEST_BUILD_STAMP` en
  `scripts/run-suites.sh` para apuntar las suites existentes a cualquiera de las
  dos implementaciones sin tocar sus aserciones. `CONTRATOS.md` con la matriz de
  rutas, códigos, cabeceras y formato en disco. Estructura Go/React.
- **DD-2** — Backend Go completo: almacén, cuota, subidas simple y troceada,
  descargas con rango, ZIP, identidad, invitados, barrido y parada.
- **DD-3** — React desde Vite con el mismo diseño, PostCSS/Tailwind, fuentes
  locales, `public/`, PWA y configuración desde Go. Imagen Alpine, `UID 1001`,
  `CGO_ENABLED=0`, `go:embed`.
- **DD-4** — Validación acotada, documentación, CI verde en el commit exacto y
  prueba de la imagen bajo las restricciones de producción.
- **DD-5** — Sólo con autorización: fusionar, publicar, verificar el artefacto,
  desplegar, smoke y observación. Node se conserva hasta cerrarla.

## Qué se prueba

Integridad del fichero descifrado · subida troceada (desorden, reenvío, trozo
corto, hash malo, cancelación) · interrupción y reanudación · rangos inválidos ·
cuotas y último hueco · última descarga concurrente · permisos ajenos · enlaces
de invitado y revocación · caducidad y agotamiento con lápida · reinicio con
transferencias en vuelo · memoria acotada con un fichero grande · recorrido de
navegador **contra la imagen final** · compatibilidad Node 2.3.1 → Go → el mismo
Node por turnos sobre un almacén sintético compartido.

Sin campañas de carga, sin comparaciones de compiladores y sin porcentajes de
ahorro como puerta de aceptación.
