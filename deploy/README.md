# Despliegue de DocDrop

El servicio escucha solo en `127.0.0.1`. Para usarlo desde fuera se levanta un
túnel temporal y se cierra al terminar:

```bash
cloudflared tunnel --url http://127.0.0.1:3010   # Ctrl-C para cerrarlo
```

## Modelo de acceso

Por defecto el servicio arranca **ABIERTO**: quien llegue a él puede subir ficheros
y ver la lista completa. Es lo razonable en red privada o tras un túnel que se abre
y se cierra a mano — pero significa que mientras el túnel esté levantado, cualquiera
con esa URL tiene acceso de escritura.

Añadiendo una contraseña al fichero de entorno el reparto pasa a ser:

| Ruta | Con contraseña configurada |
|---|---|
| `/`, `/api/upload`, `/api/files`, `/api/files/[id]`, `/api/cleanup` | Requiere contraseña |
| `/d/[id]`, `/api/info/[id]`, `/api/download/[id]` | Público (el secreto es el id de 72 bits) |

```bash
npm run set-password              # imprime las dos líneas
sudo nano /etc/docdrop.env        # descomenta y pégalas
sudo systemctl restart docdrop
```

El modo en el que ha arrancado queda registrado en el log:
`journalctl -u docdrop | grep modo`.

## Instalación

```bash
npm run build
sudo ./deploy/install.sh          # crea el usuario, despliega y arranca
```

`install.sh` es idempotente: relanzarlo despliega una versión nueva conservando
las credenciales de `/etc/docdrop.env`.

## Qué contiene el compromiso

Si alguien encontrara una ejecución remota de código en la aplicación, se
encontraría con:

- **Usuario `docdrop`**, que **no está en el grupo `docker`**. Es la contención
  más importante: el usuario `ulzuhan` sí lo está, y desde el grupo docker
  `docker run -v /:/host` da root sobre la máquina.
- **`ProtectHome=yes`** — sin acceso a `/home`: ni claves SSH, ni tokens, ni el
  resto de proyectos.
- **`ProtectSystem=strict`** — todo el disco en solo lectura salvo
  `/var/lib/docdrop`. No puede reescribir ni su propio código, que es de root.
- **`CapabilityBoundingSet=`** vacío y `NoNewPrivileges` — sin capacidades ni
  escalada por binarios setuid.
- **`SystemCallFilter`** — sin `@privileged`, `@mount`, `@swap`, `@reboot`.
- **`MemoryMax=1G` y `TasksMax=256`** — un abuso no se lleva por delante la RAM
  de los demás servicios del equipo.
- **Escucha solo en `127.0.0.1`** — la única entrada es el proxy de Tailscale.

Comprueba la nota de aislamiento con:

```bash
systemd-analyze security docdrop.service
```

## Límites de la aplicación

Configurables por variable de entorno en `/etc/docdrop.env`:

| Variable | Por defecto | Para qué |
|---|---|---|
| `DOCDROP_MAX_FILE_BYTES` | 10 GB | Tamaño máximo por fichero |
| `DOCDROP_MAX_TOTAL_BYTES` | 20 GB | Ocupación total; evita llenar el disco |
| `DOCDROP_DATA_DIR` | `/var/lib/docdrop` | Dónde viven los ficheros |

Rate limiting por IP (en memoria): 5 intentos de login cada 15 min, 30 subidas por
hora, 240 descargas por minuto. La IP sale del último valor de `X-Forwarded-For`,
que tanto Tailscale como Cloudflare sobrescriben con la real (comprobado con el
proxy de Tailscale). No se usa `X-Real-Ip`: Tailscale la deja pasar sin filtrar y
el cliente puede inventarla para esquivar el límite.

Cambiar `DOCDROP_SESSION_SECRET` invalida todas las sesiones abiertas.

## Purga periódica

Los ficheros caducados se borran al intentar accederlos, pero conviene un barrido.
Con la cookie de sesión, o desde el propio host:

```bash
curl -X POST -b "docdrop_session=<cookie>" http://127.0.0.1:3010/api/cleanup
```

## Operación

```bash
systemctl status docdrop
journalctl -u docdrop -f
ss -tlnp | grep 3010                  # confirmar que solo escucha en loopback
```
