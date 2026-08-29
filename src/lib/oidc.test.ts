/**
 * La prueba de que este cliente no está atado a ningún proveedor.
 *
 * No comprueba que funcione contra Authentik —eso ya lo dice el despliegue—,
 * sino algo más fuerte: que **obedece al documento de discovery**, sea cual
 * sea la forma de sus URLs. El documento falso de aquí abajo usa a propósito
 * las rutas de Keycloak (`/realms/…/protocol/openid-connect/…`), que no se
 * parecen en nada a las de Authentik (`/application/o/…`).
 *
 * Si alguien vuelve a escribir una ruta de proveedor a mano en `oidc.ts`,
 * estas pruebas fallan. Ese es todo su cometido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  discover,
  endSessionUrl,
  forgetDiscovery,
  oidcConfig,
  oidcConfigured,
} from "./oidc";

const EMISOR = "https://idp.ejemplo.com/realms/kaicorp";
const INTERNO = "http://idp-interno:9000";

/**
 * El emisor tal y como lo ve ESTE SERVIDOR: mismo camino, otro origen, y con
 * PUERTO. Un proveedor devuelve sus endpoints con el origen por el que se le
 * ha preguntado, y a él se le pregunta por la pata interna — así que el
 * documento viene con el puerto interno dentro.
 *
 * Este detalle no es decorativo: la primera versión de estas pruebas usaba un
 * documento que ya venía con el origen público, y por eso NO cazó que el
 * puerto interno se colaba en la URL a la que se manda al navegador. Se vio en
 * producción. El documento falso tiene que mentir como miente el de verdad.
 */
const EMISOR_INTERNO = `${INTERNO}${new URL(EMISOR).pathname}`;

const DOCUMENTO_KEYCLOAK = {
  issuer: EMISOR_INTERNO,
  authorization_endpoint: `${EMISOR_INTERNO}/protocol/openid-connect/auth`,
  token_endpoint: `${EMISOR_INTERNO}/protocol/openid-connect/token`,
  userinfo_endpoint: `${EMISOR_INTERNO}/protocol/openid-connect/userinfo`,
  end_session_endpoint: `${EMISOR_INTERNO}/protocol/openid-connect/logout`,
  jwks_uri: `${EMISOR_INTERNO}/protocol/openid-connect/certs`,
};

function entorno() {
  process.env.DOCDROP_OIDC_ISSUER = EMISOR;
  process.env.DOCDROP_OIDC_INTERNAL_BASE = INTERNO;
  process.env.DOCDROP_OIDC_CLIENT_ID = "docdrop-web";
  process.env.DOCDROP_OIDC_CLIENT_SECRET = "secreto-de-prueba";
  process.env.DOCDROP_OIDC_REDIRECT_URI = "https://docdrop.ejemplo.com/api/auth/callback";
}

let peticiones: string[] = [];

beforeEach(() => {
  entorno();
  forgetDiscovery();
  peticiones = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    peticiones.push(String(url));
    return new Response(JSON.stringify(DOCUMENTO_KEYCLOAK), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  // El reloj se movió a mano en una de las pruebas; devolverlo evita que la
  // siguiente herede una hora falsa.
  vi.useRealTimers();
  forgetDiscovery();
});

describe("configuración", () => {
  it("basta el emisor: de él sale el origen público", () => {
    const cfg = oidcConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.issuer).toBe(EMISOR);
    expect(cfg!.publicOrigin).toBe("https://idp.ejemplo.com");
    expect(cfg!.internalOrigin).toBe(INTERNO);
  });

  it("sin emisor no se deja entrar a nadie", () => {
    delete process.env.DOCDROP_OIDC_ISSUER;
    expect(oidcConfig()).toBeNull();
    expect(oidcConfigured()).toBe(false);
  });

  it("el origen interno cae al del emisor si no se dice otro", () => {
    delete process.env.DOCDROP_OIDC_INTERNAL_BASE;
    expect(oidcConfig()!.internalOrigin).toBe("https://idp.ejemplo.com");
  });
});

describe("discovery: manda el documento, no el código", () => {
  it("pregunta al emisor por su pata interna", async () => {
    await discover(oidcConfig()!);
    expect(peticiones).toEqual([
      "http://idp-interno:9000/realms/kaicorp/.well-known/openid-configuration",
    ]);
  });

  it("manda al navegador a la ruta de Keycloak, con el origen público", async () => {
    const url = new URL(await authorizeUrl(oidcConfig()!, { state: "s", codeChallenge: "c" }));
    expect(url.origin).toBe("https://idp.ejemplo.com");
    expect(url.pathname).toBe("/realms/kaicorp/protocol/openid-connect/auth");
    // Y no queda ni rastro de la forma de Authentik.
    expect(url.pathname).not.toContain("/application/o");
    // NI DEL PUERTO INTERNO. El documento lo trae; la URL pública no debe.
    expect(url.port).toBe("");
    expect(url.host).toBe("idp.ejemplo.com");
  });

  it("los endpoints de servidor van por la pata interna, con su ruta", async () => {
    const e = await discover(oidcConfig()!);
    expect(e.token).toBe("http://idp-interno:9000/realms/kaicorp/protocol/openid-connect/token");
    expect(e.userinfo).toBe("http://idp-interno:9000/realms/kaicorp/protocol/openid-connect/userinfo");
    expect(e.jwks).toBe("http://idp-interno:9000/realms/kaicorp/protocol/openid-connect/certs");
  });

  it("el cierre de sesión es el que diga el proveedor, en público", async () => {
    // Sin puerto: el cierre de sesión también lo visita el navegador.
    expect(await endSessionUrl(oidcConfig()!)).toBe(
      "https://idp.ejemplo.com/realms/kaicorp/protocol/openid-connect/logout"
    );
  });

  it("acepta como emisor tanto el público como el interno", async () => {
    // No es laxitud: lo que nace del canje servidor-a-servidor lleva el `iss`
    // interno, porque esa es la dirección por la que se pidió.
    const e = await discover(oidcConfig()!);
    expect(e.issuers).toContain(EMISOR);
    expect(e.issuers).toContain(`${INTERNO}/realms/kaicorp`);
    // El público, sin el puerto que traía el documento.
    expect(e.issuers).toContain("https://idp.ejemplo.com/realms/kaicorp");
  });

  it("no vuelve a preguntar mientras el resultado siga fresco", async () => {
    const cfg = oidcConfig()!;
    await discover(cfg);
    await discover(cfg);
    await authorizeUrl(cfg, { state: "s", codeChallenge: "c" });
    expect(peticiones).toHaveLength(1);
  });

  it("si el proveedor parpadea, sirve lo último que funcionó", async () => {
    const cfg = oidcConfig()!;
    await discover(cfg);
    forgetDiscoveryTtl();
    const fallon = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fallon);
    // No revienta: devuelve lo recordado.
    expect((await discover(cfg)).token).toContain("/protocol/openid-connect/token");
    // Y se ha comprobado que DE VERDAD volvió a intentarlo: sin esto, el
    // envejecido de la caché podría no estar funcionando y la prueba pasaría
    // sola sin probar nada.
    expect(fallon).toHaveBeenCalledTimes(1);
  });

  it("sin nada recordado, un proveedor caído es un error y no un silencio", async () => {
    forgetDiscovery();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(discover(oidcConfig()!)).rejects.toThrow(/discovery/);
  });

  it("un documento sin lo imprescindible se rechaza", async () => {
    forgetDiscovery();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ issuer: EMISOR }), { status: 200 })
    ));
    await expect(discover(oidcConfig()!)).rejects.toThrow(/authorization_endpoint/);
  });
});

/** Envejece la caché sin esperar diez minutos. */
function forgetDiscoveryTtl() {
  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
}
