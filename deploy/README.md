# Despliegue de DocDrop

Servicio expuesto a internet mediante Tailscale Funnel. Todo lo que sigue existe
porque Funnel **no** aporta WAF, rate limiting ni filtrado: lo que proteja el
servicio tiene que estar en la aplicación y en el aislamiento del proceso.

## Modelo de acceso

| Ruta | Acceso |
|---|---|
| `/`, `/api/upload`, `/api/files`, `/api/cleanup` | Contraseña |
| `/d/[id]`, `/api/info/[id]`, `/api/download/[id]` | Público (el secreto es el id de 72 bits) |

Así se comparte un fichero con alguien de fuera sin darle credenciales, pero nadie
puede subir ni enumerar lo que hay.

## Instalación

```bash
npm run build
sudo ./deploy/install.sh          # crea el usuario, despliega y arranca
tailscale funnel --bg --https=8443 http://127.0.0.1:3010
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
hora, 240 descargas por minuto. La IP se lee de `X-Forwarded-For`, que Tailscale
**sobrescribe** con la real (comprobado); no se usa `X-Real-Ip`, que Tailscale deja
pasar tal cual y el cliente puede falsificar.

## Cambiar la contraseña

```bash
npm run set-password              # o: npm run set-password 'mi contraseña'
sudo nano /etc/docdrop.env        # pega las dos líneas
sudo systemctl restart docdrop
```

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
tailscale funnel status
tailscale funnel --https=8443 off     # dejar de publicarlo en internet
```
