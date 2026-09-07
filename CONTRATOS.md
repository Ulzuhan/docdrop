# Contratos de DocDrop

Lo que la implementación de Go tiene que cumplir para poder sustituir a la de
Node **y para que se pueda volver atrás sobre los mismos datos**. Referencia:
la versión 2.3.1, imagen
`ghcr.io/ulzuhan/docdrop:2.3.1@sha256:525ef454305d7455c774d4463d11feb029ba8091ef4b83508a7b4002c19f0f67`.

Las suites `acceso`, `ficheros`, `upload`, `e2ee` y `backchannel` se ejecutan
contra cualquiera de las dos con `DOCDROP_TEST_LAUNCH`, **sin cambiar ninguna
aserción**. Dan salida idéntica.

## 1. El árbol de datos

```text
<DATA>/<id>/file            contenido (bulto cifrado si es de punta a punta)
<DATA>/<id>/meta.json       ficha del fichero
<DATA>/<id>/session.json    subida troceada en curso
<DATA>/<id>/parts/<n>       marcador vacío del trozo n
<DATA>/users/<sha256(sub)>.json
<DATA>/guests/<token>.json
<DATA>/revocaciones.json
```

- `id`: 9 bytes aleatorios en hexadecimal (18 caracteres). Se acepta
  `^[0-9a-f]{12,64}$`. Token de invitado: 16 bytes (32 caracteres).
- **Fechas en milisegundos Unix**, no en segundos.
- Escritura atómica (temporal + `rename`) para `meta.json` y
  `revocaciones.json`; esta última con permisos `0600`.
- `users` y `guests` no casan con el formato de id, y por eso los recorridos del
  almacén los ignoran. No se crean directorios nuevos con nombre hexadecimal.

### `meta.json`

| Campo | Tipo | Presencia |
|---|---|---|
| `id`, `originalName`, `mimeType` | string | siempre |
| `size`, `uploadedAt`, `expiresAt` | número | siempre |
| `downloadCount`, `maxDownloads` | número | **siempre, aunque valgan 0** |
| `uploadedBy` | string | sólo si hay etiqueta |
| `owner` | `user:<id>` | sólo si tiene dueño |
| `encrypted` | `true` | sólo si es un bulto cifrado; nunca `false` |
| `burnedAt`, `burnedReason` | número / `expired`\|`exhausted` | sólo en lápidas |

Los contadores no llevan `omitempty` **y no se les puede poner**: Node hace
`fresh.downloadCount++` sin comprobar nada, así que un campo ausente da `NaN`,
se escribe como `null`, y a partir de ahí `maxDownloads` deja de tener efecto.
Hay regresión en los dos sentidos.

### `session.json`

`id`, `originalName`, `size`, `mimeType`, `ttlHours`, `maxDownloads`,
`chunkSize`, `totalParts`, `createdAt`, `sessionExpiresAt` siempre;
`uploadedBy`, `owner` (`user:<id>` o `guest:<token>`) y `encrypted` opcionales.
El blob se preasigna al tamaño final y cada trozo se escribe en su
desplazamiento.

## 2. Rutas y códigos

| Ruta | Método | Acceso | Respuestas |
|---|---|---|---|
| `/api/upload` | POST | sesión o invitado | 200, 400 (sin cuerpo / sin `x-filename` / mal codificado / fichero vacío), 403 (origen), 401, 413, 429, 507 |
| `/api/upload/init` | POST | sesión o invitado | 200, 400 (JSON inválido, sin `filename`, `size` no entero positivo), 401, 413, 429, 507 |
| `/api/upload/{id}` | GET | dueño de la subida | 200, 404 (ajeno o inexistente), 410 (caducada), 401 |
| `/api/upload/{id}` | DELETE | dueño de la subida | 200, 404, 401 |
| `/api/upload/{id}/part/{n}` | PUT | dueño de la subida | 200 (también `alreadyReceived`), 400 (índice, cuerpo vacío, trozo corto), 404, 410, 413, 422 (hash), 429 |
| `/api/upload/{id}/complete` | POST | dueño de la subida | 200, 403 (origen), 404, 409 (`missing`), 410 |
| `/api/download/{id}` | GET | público | 200, 206, 404, 410, 416, 429 |
| `/api/info/{id}` | GET | público | 200, 404, 410 (`reason`), 429 |
| `/api/zip` | GET | público | 200, 400, 410, 429 |
| `/api/files` | GET | sesión | 200, 401 |
| `/api/files/{id}` | DELETE | dueño | 200, 404, 401 |
| `/api/cleanup` | POST | sesión | 200, 401, 403 |
| `/api/guest-links` | GET/POST | sesión | 200 / 201, 400, 401, 429 |
| `/api/guest-links/{token}` | DELETE | emisor | 200, 404, 401 |
| `/api/guest/{token}` | GET | público | 200, 404, 429 |
| `/api/auth/login` | GET | público | 302, 503 |
| `/api/auth/callback` | GET | público | 302 (relativo) |
| `/api/auth/logout` | POST | pública, con cookie | 200 (`next`), 403 |
| `/api/auth/backchannel-logout` | POST | proveedor | 200, 400, 404, 413, 503 |
| `/`, `/d/{id}`, `/guest/{token}` | GET | páginas | 200 |
| `/share` | POST/GET | público | 303 `/?shared=error` / 307 `/` |
| `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | GET | público | 200 |

Un fichero, una subida o un enlace **ajeno** responde lo mismo que uno
inexistente: estos endpoints no deben servir para averiguar qué hay.

### Cabeceras

- Todas las respuestas: `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `Strict-Transport-Security` y la CSP con nonce
  por respuesta.
- Descargas: `Accept-Ranges`, `Cache-Control: no-store`,
  `Content-Disposition` (RFC 5987/6266), `Content-Range` en 206 y 416.
- `robots.txt` y `sitemap.xml` son **byte a byte** los de Node.

### Límites de peticiones

`download` 240/min · `info` 120/min · `zip` 30/min · `upload` 30/h ·
`upload-init` 30/h · `upload-part` 5000/h · `guest-links` 30/h ·
`guest-check` 30/15 min. Ventana deslizante; la clave es `acción:ip` y la IP es
el **último** elemento de `X-Forwarded-For`, o `direct` sin proxy.

### Validación, igual que en JavaScript

`Number(null)` es 0 y `Number(undefined)` es NaN, así que **subir sin cabecera
`x-ttl-hours` da 1 hora y llamar a `init` sin `ttlHours` da 24**. No es un
descuido del port: es lo que hace 2.3.1, y las suites lo comprueban. Igual con
`0x10` → 16, `1e2` → 100, `"abc"` → el valor por defecto.

## 3. Contabilidad

- Una descarga cuenta **al entregar el último byte**, no al pedirla.
- Una petición en vuelo ocupa plaza contra el límite (TTL 2 h).
- Las continuaciones por rango son gratis sólo para un cliente que ya pagó una
  descarga completa (clave `id\0cliente`, TTL 1 h), apuntadas **después** de
  contabilizar.
- La vista previa (`?inline=1`, tipos seguros, SVG excluido) ni cuenta ni
  registra continuación.
- La cuota se reserva bajo candado, se transfiere fuera y se suelta siempre.
- Plazas, continuaciones y reservas viven en memoria y se pierden al reiniciar.

## 4. Identidad

- `docdrop_session` = `base64url(JSON{uid,iat,exp})` `.` `base64url(HMAC-SHA256)`.
  Con el mismo secreto vale en las dos implementaciones, en los dos sentidos.
- El id de la cookie se busca en disco: una cuenta borrada deja de funcionar en
  el acto.
- Cookie temporal de login `docdrop_oidc`, escapada como componente de URL.
- Revocación por `revocaciones.json`, podada a 25 h. Si no se puede escribir,
  **503**.

## 5. Cifrado de punta a punta

`src/lib/e2ee.ts` es el único sitio donde hay cifrado, y vive en el navegador.
El servidor sólo lee el prefijo EN CLARO del bulto (magia `DDE1`, tamaño de
trozo, longitud de cabecera, tope 64 KiB) para devolver la cabecera cifrada en
`/api/info`. **No descifra nada y no ve ninguna clave.**

## 6. Diferencias intencionadas frente a 2.3.1

1. **`exp` obligatorio** en el `logout_token`. Antes se validaba sólo si venía y
   era numérico, así que un aviso sin `exp` se aceptaba.
2. **Un aviso con `sid` y sin `sub`** responde 400 diciendo que no se soporta,
   en vez de 200 sin haber revocado nada.
3. **`iat` no puede tener más de 5 minutos.** Es una restricción nueva, la misma
   que ya adoptó QR-Forge: acota el reenvío más allá de la caché de `jti`.
4. **El barrido de sesiones no borra una entrada que ya tiene ficha.** Antes,
   una limpieza fallida al completar dejaba la sesión puesta y el barrido
   retiraba el fichero entero 24 h después.
5. **`/api/zip` rechaza bultos cifrados** con 400 y un motivo. El panel ya los
   excluía de la selección; lo que quedaba abierto era la URL a mano, que
   empaquetaba ciphertext inservible y gastaba una descarga de cada uno.
6. **Healthcheck propio** (`/healthz`, `docdrop sonda`) en vez de
   `/api/info/<id>`, que pasa por el limitador y comparte cupo con el tráfico
   real.
7. **Cookies `Secure` por defecto**, con excepción explícita
   (`DOCDROP_INSECURE_COOKIES=1`). Node lo ataba a `NODE_ENV`, que en un binario
   no existe.
8. **El ZIP puede llevar `Content-Length`** cuando el archivo es pequeño y el
   servidor ya lo tiene entero en el búfer. Con archivos grandes —el caso real—
   sale en flujo y sin longitud, como en Node.
9. **`/healthz`** es una ruta nueva. No expone nada: responde `ok`.
10. **Una petición con sesión Y token de invitado vale por las dos.** En 2.3.1,
    `credencialDe` devolvía la de la sesión si la había y sólo miraba el
    invitado si no. Con eso, alguien con cuenta que abriera un enlace de
    invitado en el mismo navegador —el operador probando el suyo, o cualquiera
    con cuenta que reciba uno— abría la subida troceada como `guest:<token>`
    (ahí ganaba el invitado) y luego cada trozo se identificaba como `user:<id>`
    (ahí ganaba la sesión): no coincidían nunca y la subida moría con 404
    «Upload session not found». Reproducido en el navegador contra la imagen
    publicada 2.3.1. Ahora se comprueban **todas** las credenciales que trae la
    petición. Lo que la comprobación protege sigue protegido: con dos enlaces de
    invitado distintos, el segundo sigue sin poder tocar la subida del primero.

11. **Dos escrituras del mismo trozo se serializan.** Cada trozo se escribe en
    su posición dentro del fichero final, así que dos peticiones del mismo
    índice escriben en el mismo sitio. En 2.3.1 se entrelazaban, y lo peor no
    era el desorden: una petición RECHAZADA por checksum ya había dejado sus
    bytes puestos, la buena contestaba 200 y marcaba el trozo, y el fichero que
    alguien descargaba llevaba dentro los bytes de la rechazada, sin que nada
    fallara en ningún momento. Ahora cada índice va con su candado y se vuelve a
    mirar dentro de él: un reenvío que llega cuando el trozo ya está puesto y
    verificado contesta `alreadyReceived` **sin escribir**, traiga los bytes que
    traiga. Los trozos distintos siguen entrando en paralelo.
12. **Completar y cancelar toman la subida en exclusiva.** No pueden ejecutarse
    mientras se está escribiendo un trozo. Antes, un trozo en vuelo podía seguir
    escribiendo después de que `completar` hubiera leído el tamaño y escrito la
    ficha —fichero terminado con su enlace repartido y su ficha diciendo otro
    tamaño— y volvía a crear `parts/` dentro. Un `completar` repetido sobre una
    subida ya cerrada devuelve su ficha en vez de rehacerla; los que llegan
    cuando la sesión ya no está siguen recibiendo 404, como en Node.

    **Lo que esto cuesta**, dicho antes de que se note: cancelar espera al trozo
    que se esté escribiendo. En la práctica no se ve, porque el cliente aborta
    su propia petición al cancelar y el servidor deja de leer al instante; sólo
    se notaría si el cierre viniera de otro sitio distinto del que sube, y
    entonces la espera está acotada por un trozo (32 MiB por defecto).
13. **El ZIP toma el tamaño del disco y comprueba que cuadra con la ficha.** Se
    armaba con el tamaño de la ficha y se copiaba acotado a él: un fichero más
    corto —truncado por un fallo de escritura o un disco lleno— terminaba en EOF
    sin error, el archivo se cerraba como bueno y **cada fichero contaba como
    descargado**. Quien lo abría se llevaba un fichero corto sin que nada se lo
    dijera. Ahora un fichero que no cuadra se queda fuera y suelta su plaza sin
    contar, y si se queda corto a mitad de envío el archivo **no se cierra**:
    sin su directorio central, quien lo recibe ve un archivo roto, que es la
    verdad.

Lo que **no** es una diferencia, aunque lo pareciera: el HTML de las páginas sale
con el mismo `Cache-Control: private, no-cache, no-store, max-age=0,
must-revalidate` que emite Node, y un id inválido en `/d/<id>` llega al cliente
tal cual —escapado por `html/template`— para que la página conteste lo mismo que
contestaba antes a quien copió mal un enlace.

## 7. Lo que se prueba, y dónde

| Comprobación | Dónde |
|---|---|
| Contratos HTTP, permisos, validación, cuotas | `scripts/run-suites.sh` (156 comprobaciones), contra las dos |
| Cierre de sesión por aviso firmado | `scripts/test-backchannel.sh`, contra las dos |
| Rangos, continuaciones, plazas, ZIP | `go test ./internal/httpapi` |
| Carreras entre peticiones: dos escrituras del mismo trozo, reenvío rechazado, completar y cancelar con un trozo en vuelo, cierres simultáneos | `go test -race ./internal/httpapi` (`carreras_test.go`) |
| ZIP con un fichero más corto que su ficha, y truncado a mitad de envío | `go test ./internal/httpapi` (`zip_test.go`) |
| Almacén, cuota, lápidas, concurrencia | `go test ./internal/store` |
| Subidas troceadas y barrido | `go test ./internal/uploads` |
| Parada con transferencias en vuelo | `go test ./cmd/docdrop` |
| Recorrido de navegador, integridad del fichero descifrado **por el camino en flujo** | `scripts/test-navegador.sh` (39 comprobaciones), contra el binario y contra la imagen |

El recorrido pasa entero contra el binario y contra la imagen. **Contra el
artefacto de Node falla una comprobación**: la subida por el enlace de invitado
desde un navegador con sesión, que es el defecto 10 de arriba. No es una
regresión del port —está en 2.3.1— y es la razón de que ese punto se corrija.
| Node 2.3.1 → Go → el mismo Node | `scripts/test-compatibilidad.sh` (55 comprobaciones) |
| Uso de memoria acotado | 1 GiB de ida y vuelta contra el binario: RSS 11,6 → 12,9 MB, SHA-256 idéntico, rango de 500 MB exacto |
