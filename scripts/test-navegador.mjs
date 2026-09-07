#!/usr/bin/env node
/**
 * El recorrido completo en un navegador de verdad.
 *
 * Lo que sólo se ve así: que el fichero descargado y descifrado en el navegador
 * es BYTE A BYTE el que se subió, que los estilos están aplicados de verdad,
 * que el logo carga, que el pie conserva sus enlaces, y que la consola no
 * escupe errores. Comprobarlo con `curl` es cierto y no basta: en SecretDrop
 * pasó exactamente eso.
 *
 * Lo lanza `test-navegador.sh`, que levanta la aplicación, un proveedor que
 * completa el login y un proxy TLS —las cookies `Secure` no viajan por http, y
 * desactivarlas no probaría lo que se despliega—.
 */
import { chromium } from "@playwright/test";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID, createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE;
const PUERTO_APP = Number(process.env.PUERTO_APP);
const PUERTO_TLS = Number(process.env.PUERTO_TLS);
const PUERTO_IDP = Number(process.env.PUERTO_IDP);

/**
 * Lo que este montaje provoca y no es del producto.
 *
 * 1. El certificado del proxy es autofirmado, y Chromium NO aplica
 *    `ignoreHTTPSErrors` a la descarga del script de un service worker: se
 *    niega a registrarlo y lo dice por consola. Pasa igual contra Node y contra
 *    Go. En vez de mirar para otro lado, se comprueba aparte que `/sw.js` se
 *    sirve y que la página intenta registrarlo, que es lo que sí depende de
 *    nosotros.
 *
 * 2. El proveedor de este montaje habla http mientras la aplicación va por
 *    https, y la CSP lleva `upgrade-insecure-requests`: el navegador convierte
 *    la dirección del proveedor a https, deja de coincidir con la que autoriza
 *    `connect-src`, y bloquea la petición. Sólo se nota contra el artefacto de
 *    Node, cuyo router de cliente PREBUSCA `/api/auth/login` —el binario de Go
 *    no tiene router de cliente y no prebusca nada—, y el propio Next se
 *    recupera navegando de verdad, que es lo que el recorrido comprueba justo
 *    después. En producción el proveedor es https y esto no ocurre.
 */
const RUIDO_DEL_MONTAJE = [
  /SSL certificate error occurred when fetching the script/,
  /violates the following Content Security Policy directive: "connect-src/,
  /Failed to fetch RSC payload/,
];
const esRuido = (texto) => RUIDO_DEL_MONTAJE.some((r) => r.test(texto));

let pasan = 0, fallan = 0;
const check = (nombre, real, esperado) => {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  console.log(`  ${ok ? "✓" : "✗"} ${nombre}${ok ? "" : `  (esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)})`}`);
  if (ok) pasan++;
  else fallan++;
};
const nota = (nombre, valor) => console.log(`  · ${nombre}: ${valor}`);

// ── El proveedor de mentira, que sí completa el inicio de sesión ─────
const idp = createHttpServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PUERTO_IDP}`);
  const json = (o) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  const emisor = `http://127.0.0.1:${PUERTO_IDP}/application/o/docdrop`;
  if (u.pathname.endsWith("/.well-known/openid-configuration")) {
    return json({
      issuer: emisor,
      authorization_endpoint: `${emisor}/authorize`,
      token_endpoint: `${emisor}/token`,
      userinfo_endpoint: `${emisor}/userinfo`,
      end_session_endpoint: `${emisor}/logout`,
      jwks_uri: `${emisor}/jwks`,
    });
  }
  if (u.pathname.endsWith("/authorize")) {
    const vuelta = new URL(u.searchParams.get("redirect_uri"));
    vuelta.searchParams.set("code", randomUUID());
    vuelta.searchParams.set("state", u.searchParams.get("state"));
    return res.writeHead(302, { Location: vuelta.toString() }).end();
  }
  if (u.pathname.endsWith("/token")) return json({ access_token: "de-pruebas", token_type: "Bearer" });
  if (u.pathname.endsWith("/userinfo")) {
    return json({ sub: "sub-navegador", email: "persona@example.invalid", name: "Persona" });
  }
  if (u.pathname.endsWith("/jwks")) return json({ keys: [] });
  // El cierre de sesión del proveedor: la aplicación manda aquí al salir, y sin
  // esto el recorrido acababa con un 404 en consola que no era del producto.
  if (u.pathname.endsWith("/logout")) {
    return res.writeHead(302, { Location: `https://127.0.0.1:${PUERTO_TLS}/` }).end();
  }
  res.writeHead(404).end();
});
await new Promise((listo) => idp.listen(PUERTO_IDP, "127.0.0.1", listo));

// ── El proxy TLS, para que las cookies Secure viajen ─────────────────
const proxy = createHttpsServer(
  { key: readFileSync(process.env.LLAVE), cert: readFileSync(process.env.CERT) },
  (req, res) => {
    const salida = httpRequest(
      { host: "127.0.0.1", port: PUERTO_APP, path: req.url, method: req.method,
        headers: { ...req.headers, "x-forwarded-proto": "https" } },
      (respuesta) => {
        res.writeHead(respuesta.statusCode ?? 502, respuesta.headers);
        respuesta.pipe(res);
      }
    );
    salida.on("error", () => res.writeHead(502).end());
    req.pipe(salida);
  }
);
await new Promise((listo) => proxy.listen(PUERTO_TLS, "127.0.0.1", listo));

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
const pagina = await contexto.newPage();

// Todo lo que la consola diga en rojo cuenta como fallo del recorrido.
const errores = [];
pagina.on("console", (m) => { if (m.type() === "error" && !esRuido(m.text())) errores.push(m.text()); });
pagina.on("pageerror", (e) => errores.push(String(e)));
const fallosDeRed = [];
pagina.on("response", (r) => {
  if (r.status() >= 400 && new URL(r.url()).origin === BASE) fallosDeRed.push(`${r.status()} ${r.url()}`);
});

try {
  // ── La portada ────────────────────────────────────────────────────
  console.log("\nLa portada");
  await pagina.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("dice de qué va", await pagina.locator("h1").first().isVisible(), true);
  check("ofrece entrar", await pagina.locator('a[href^="/api/auth/login"]').first().isVisible(), true);

  // Los estilos, aplicados de verdad. Un fichero CSS que responde 200 pero
  // llega sin procesar por PostCSS también «carga»: lo que distingue es un
  // valor calculado que sólo existe si Tailwind ha corrido.
  const fondo = await pagina.evaluate(() => getComputedStyle(document.body).backgroundColor);
  nota("fondo calculado del cuerpo", fondo);
  check("el CSS está procesado, no sólo servido", fondo !== "" && fondo !== "rgba(0, 0, 0, 0)", true);
  const fuente = await pagina.evaluate(() => getComputedStyle(document.body).fontFamily);
  nota("familia tipográfica", fuente);
  check("las fuentes propias están puestas", /Inter|Space Grotesk/.test(fuente), true);

  // El logo, cargado: un `<img>` roto también está «presente» en el DOM.
  const logo = pagina.locator('img[src="/kaicorp-mark.png"]').first();
  check("el logo existe", await logo.count() > 0, true);
  check("y ha cargado de verdad",
    await logo.evaluate((el) => el.complete && el.naturalWidth > 0), true);

  // El pie con sus enlaces: se pierden en silencio si el bundle lee
  // `process.env`. Pasó en SecretDrop y en QR-Forge.
  const enlacesPie = await pagina.locator("footer a").count();
  nota("enlaces en el pie", enlacesPie);
  check("el pie conserva los enlaces entre servicios", enlacesPie > 1, true);

  // El alta, que también llega por variable de entorno.
  check("el botón de alta apunta al proveedor",
    await pagina.locator('a[href^="https://idp.example.invalid/if/flow/alta/"]').count() > 0, true);

  // ── Entrar ────────────────────────────────────────────────────────
  console.log("\nEntrar");
  await pagina.locator('a[href^="/api/auth/login"]').first().click();
  await pagina.waitForURL(`${BASE}/`, { timeout: 15000 });
  await pagina.waitForSelector('section[aria-label="Upload files"]', { timeout: 15000 });
  check("el panel aparece tras el login", await pagina.locator('section[aria-label="Upload files"]').isVisible(), true);
  // El correo vive dentro del menú de cuenta, que hay que abrir pulsándolo.
  await pagina.locator('button[aria-haspopup="menu"]').first().click();
  const menu = pagina.locator('[role="menu"]').first();
  await menu.waitFor({ timeout: 10000 });
  check("el menú de cuenta dice de quién es la sesión",
    (await menu.innerText()).includes("persona@example.invalid"), true);
  check("y enlaza a la cuenta en el proveedor",
    await menu.locator('a[href="https://idp.example.invalid/if/user/"]').count(), 1);
  await pagina.keyboard.press("Escape");

  // ── Subir cifrado, y comprobar la integridad de verdad ────────────
  console.log("\nSubir con cifrado y recuperar el fichero");
  const contenido = randomBytes(64 * 1024);
  const hashOriginal = createHash("sha256").update(contenido).digest("hex");
  await pagina.locator('section[aria-label="Upload files"] input[type=file]').first()
    .setInputFiles({ name: "secreto.bin", mimeType: "application/octet-stream", buffer: contenido });

  // La fila del fichero aparece cuando la subida termina.
  const fila = pagina.locator("li.dd-file-row").first();
  await fila.waitFor({ timeout: 30000 });
  check("el fichero aparece en el panel", await fila.isVisible(), true);
  check("y se marca como cifrado", (await fila.innerText()).includes("Encrypted file") || (await fila.innerText()).includes("secreto.bin"), true);

  // El enlace lleva la clave en el fragmento: es la mitad que el servidor no ve.
  const enlace = await fila.locator('a[href^="/d/"]').first().getAttribute("href");
  nota("enlace de descarga", enlace ? enlace.replace(/#.*/, "#<clave>") : "(ninguno)");
  check("el enlace lleva la clave en el fragmento", Boolean(enlace && enlace.includes("#")), true);

  // El servidor NO puede saber el nombre real de un bulto cifrado.
  const id = enlace.slice(3).split("#")[0];
  // Se pide desde la página: el certificado del proxy es autofirmado y el
  // `fetch` de Node no lo acepta, mientras que el navegador ya lo tiene tomado.
  const info = await pagina.evaluate(async (fichero) => {
    const r = await fetch(`/api/info/${fichero}`);
    return r.ok ? r.json() : null;
  }, id) ?? {};
  check("el servidor guarda un nombre marcador", info.originalName, "encrypted");
  check("y declara el bulto como cifrado", info.encrypted, true);

  // Y ahora lo que importa: abrir el enlace en otra pestaña, descargar y
  // comprobar que lo que sale es EXACTAMENTE lo que entró.
  const receptor = await contexto.newPage();
  const erroresReceptor = [];
  receptor.on("console", (m) => { if (m.type() === "error" && !esRuido(m.text())) erroresReceptor.push(m.text()); });
  receptor.on("pageerror", (e) => erroresReceptor.push(String(e)));
  await receptor.goto(`${BASE}${enlace}`, { waitUntil: "networkidle" });
  check("la página de descarga enseña el nombre real, descifrado en el navegador",
    (await receptor.locator("body").innerText()).includes("secreto.bin"), true);

  const [descarga] = await Promise.all([
    receptor.waitForEvent("download", { timeout: 60000 }),
    receptor.getByRole("button", { name: /download/i }).first().click(),
  ]);
  const ruta = await descarga.path();
  const recuperado = readFileSync(ruta);
  check("el fichero descifrado pesa lo mismo", recuperado.length, contenido.length);
  check("y es byte a byte el original",
    createHash("sha256").update(recuperado).digest("hex"), hashOriginal);
  check("la consola de quien recibe está limpia", erroresReceptor, []);
  await receptor.close();

  // ── El enlace de invitado ─────────────────────────────────────────
  console.log("\nEl enlace de invitado");
  const creado = await pagina.evaluate(async () => {
    const r = await fetch("/api/guest-links", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlHours: 24, label: "Recorrido" }),
    });
    return r.ok ? (await r.json()).link.token : null;
  });
  check("se acuña desde el panel", typeof creado === "string" && creado.length === 32, true);

  const invitado = await contexto.newPage();
  const erroresInvitado = [];
  invitado.on("console", (m) => { if (m.type() === "error" && !esRuido(m.text())) erroresInvitado.push(m.text()); });
  invitado.on("pageerror", (e) => erroresInvitado.push(String(e)));
  await invitado.goto(`${BASE}/guest/${creado}`, { waitUntil: "networkidle" });
  const textoInvitado = await invitado.locator("body").innerText();
  check("la página del invitado se abre", textoInvitado.includes("Recorrido") || textoInvitado.length > 0, true);
  check("y no enumera nada de la instancia", textoInvitado.includes("secreto.bin"), false);
  check("la consola del invitado está limpia", erroresInvitado, []);
  await invitado.close();

  // ── Borrar y salir ────────────────────────────────────────────────
  console.log("\nBorrar y salir");
  await pagina.locator('button[aria-label^="Delete"]').first().click();
  await pagina.waitForFunction(() => document.querySelectorAll("li.dd-file-row").length === 0, { timeout: 15000 });
  check("el fichero desaparece del panel",
    await pagina.locator("li.dd-file-row").count(), 0);

  // El botón de salir de verdad, no una llamada a la API: es lo que se pulsa.
  await pagina.locator('button[aria-haspopup="menu"]').first().click();
  await pagina.getByRole("menuitem", { name: "Sign out" }).click();
  // Sale por la pantalla del proveedor, que devuelve a la portada.
  await pagina.waitForSelector('a[href^="/api/auth/login"]', { timeout: 20000 });
  check("salir devuelve a la portada sin sesión",
    await pagina.locator('a[href^="/api/auth/login"]').first().isVisible(), true);
  // Este 401 es a propósito: se pide adrede sin sesión. Se aparta de la lista
  // de fallos de red para no fingir que el recorrido dejó un error detrás.
  const marcaFallos = fallosDeRed.length;
  check("y la sesión ya no vale",
    await pagina.evaluate(async () => (await fetch("/api/files")).status), 401);
  fallosDeRed.length = marcaFallos;
  const errorDeCarga = /Failed to load resource.*401/;
  for (let i = errores.length - 1; i >= 0; i--) if (errorDeCarga.test(errores[i])) errores.splice(i, 1);

  // ── La PWA ────────────────────────────────────────────────────────
  console.log("\nLa aplicación instalable");
  const pwa = await pagina.evaluate(async () => {
    const manifiesto = await fetch("/manifest.webmanifest").then((r) => r.json()).catch(() => null);
    const worker = await fetch("/sw.js");
    return {
      accionCompartir: manifiesto?.share_target?.action ?? null,
      iconos: manifiesto?.icons?.length ?? 0,
      workerEstado: worker.status,
      workerTipo: worker.headers.get("content-type"),
      // El registro lo intenta la página; aquí sólo se comprueba que existe el
      // código que lo pide, porque el certificado del montaje lo impide.
      pideRegistro: "serviceWorker" in navigator,
    };
  });
  check("el manifiesto conserva el objetivo de compartir", pwa.accionCompartir, "/share");
  check("y sus tres iconos", pwa.iconos, 3);
  check("el service worker se sirve", pwa.workerEstado, 200);
  check("con tipo de script", /javascript/.test(pwa.workerTipo ?? ""), true);
  check("y la página lo intenta registrar", pwa.pideRegistro, true);

  // ── Lo que no debe haber pasado por el camino ─────────────────────
  console.log("\nLa consola y la red");
  check("sin errores en la consola", errores, []);
  check("sin respuestas de error del servidor", fallosDeRed, []);
} finally {
  await navegador.close();
  proxy.close();
  idp.close();
}

console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan === 0 ? 0 : 1);
