/**
 * El cifrado, probado contra lo que promete — no contra lo que hace.
 *
 * Cada test de manipulación existe porque hay un ataque concreto detrás: el
 * servidor custodia el bulto, así que el adversario del formato ES el servidor
 * (o quien lo comprometa). Reordenar, truncar y extender son exactamente lo que
 * un custodio malicioso puede hacer sin la clave, y las tres cosas tienen que
 * romper el descifrado, no pasar desapercibidas.
 */
import { describe, expect, it } from "vitest";
import {
  ETIQUETA,
  cifrarFichero,
  cifrarTrozo,
  claveAFragmento,
  claveDesdeFragmento,
  descifrarCabecera,
  descifrarFichero,
  descifrarTrozo,
  cifrarCabecera,
  leerPrefijo,
  nuevaClave,
} from "./e2ee";

/** Trozos diminutos para ejercitar el multi-trozo sin cifrar megas en cada test. */
const TROZO = 1024;

const datos = (n: number) => {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = i % 251;
  return d;
};

describe("la clave y el fragmento", () => {
  it("viaja al fragmento y vuelve idéntica", () => {
    const clave = nuevaClave();
    expect(claveDesdeFragmento(claveAFragmento(clave))).toEqual(clave);
  });

  it("acepta el fragmento con o sin #", () => {
    const clave = nuevaClave();
    expect(claveDesdeFragmento("#" + claveAFragmento(clave))).toEqual(clave);
  });

  it("un enlace recortado da null, no una explosión", () => {
    expect(claveDesdeFragmento("")).toBeNull();
    expect(claveDesdeFragmento("abc")).toBeNull();
    expect(claveDesdeFragmento(claveAFragmento(nuevaClave()).slice(0, -1))).toBeNull();
  });
});

describe("ida y vuelta", () => {
  it("un fichero pequeño (un solo trozo)", async () => {
    const clave = nuevaClave();
    const claro = datos(100);
    const bulto = await cifrarFichero(clave, { name: "informe.pdf", mimeType: "application/pdf", size: 100 }, claro, TROZO);
    const abierto = await descifrarFichero(clave, bulto);
    expect(abierto?.cabecera.name).toBe("informe.pdf");
    expect(abierto?.datos).toEqual(claro);
  });

  it("un fichero de varios trozos, con el último parcial", async () => {
    const clave = nuevaClave();
    const claro = datos(TROZO * 3 + 217);
    const bulto = await cifrarFichero(clave, { name: "v", mimeType: "video/mp4", size: claro.length }, claro, TROZO);
    const abierto = await descifrarFichero(clave, bulto);
    expect(abierto?.datos).toEqual(claro);
  });

  it("un fichero que cae exacto en frontera de trozo", async () => {
    const clave = nuevaClave();
    const claro = datos(TROZO * 2);
    const bulto = await cifrarFichero(clave, { name: "x", mimeType: "application/octet-stream", size: claro.length }, claro, TROZO);
    expect((await descifrarFichero(clave, bulto))?.datos).toEqual(claro);
  });

  it("el nombre sobrevive con unicode y comillas", async () => {
    const clave = nuevaClave();
    const cabecera = { name: 'despido "Juan" — año 2026 🗂️.pdf', mimeType: "application/pdf", size: 1 };
    const abierta = await descifrarCabecera(clave, await cifrarCabecera(clave, cabecera));
    expect(abierta).toEqual(cabecera);
  });

  it("el prefijo del bulto no delata más que tamaños", async () => {
    const clave = nuevaClave();
    const bulto = await cifrarFichero(clave, { name: "secreto.txt", mimeType: "text/plain", size: 20 }, datos(20), TROZO);
    const texto = new TextDecoder("latin1").decode(bulto);
    expect(texto.includes("secreto")).toBe(false);
    expect(texto.includes("text/plain")).toBe(false);
  });
});

describe("determinismo: lo que la reanudación necesita", () => {
  it("el mismo trozo con la misma clave produce el mismo ciphertext", async () => {
    const clave = nuevaClave();
    const claro = datos(TROZO);
    expect(await cifrarTrozo(clave, claro, 4, false)).toEqual(await cifrarTrozo(clave, claro, 4, false));
  });

  it("y con otro índice, uno completamente distinto", async () => {
    const clave = nuevaClave();
    const claro = datos(TROZO);
    expect(await cifrarTrozo(clave, claro, 4, false)).not.toEqual(await cifrarTrozo(clave, claro, 5, false));
  });
});

describe("lo que un custodio malicioso puede intentar, y falla", () => {
  const montar = async () => {
    const clave = nuevaClave();
    const claro = datos(TROZO * 3);
    const bulto = await cifrarFichero(clave, { name: "f", mimeType: "x/y", size: claro.length }, claro, TROZO);
    const prefijo = leerPrefijo(bulto)!;
    return { clave, bulto, desde: prefijo.datosDesde, trozoCifrado: TROZO + ETIQUETA };
  };

  it("cambiar un byte del contenido", async () => {
    const { clave, bulto, desde } = await montar();
    bulto[desde + 100] ^= 0x01;
    await expect(descifrarFichero(clave, bulto)).rejects.toThrow();
  });

  it("cambiar un byte de la cabecera cifrada", async () => {
    const { clave, bulto } = await montar();
    bulto[14] ^= 0x01;
    await expect(descifrarFichero(clave, bulto)).rejects.toThrow();
  });

  it("reordenar dos trozos (cada uno íntegro por sí mismo)", async () => {
    const { clave, bulto, desde, trozoCifrado } = await montar();
    const a = bulto.slice(desde, desde + trozoCifrado);
    const b = bulto.slice(desde + trozoCifrado, desde + 2 * trozoCifrado);
    bulto.set(b, desde);
    bulto.set(a, desde + trozoCifrado);
    await expect(descifrarFichero(clave, bulto)).rejects.toThrow();
  });

  it("truncar en una frontera de trozo: un prefijo válido no es el fichero", async () => {
    const { clave, bulto, desde, trozoCifrado } = await montar();
    // El custodio entrega solo los dos primeros trozos y encoge la cabecera no
    // puede: miente el descifrador contando trozos contra `size`. Simulamos el
    // recorte crudo del bulto: el descifrado debe fallar, no devolver 2/3.
    const truncado = bulto.slice(0, desde + 2 * trozoCifrado);
    await expect(descifrarFichero(clave, truncado)).rejects.toThrow();
  });

  it("añadir bytes después del último trozo", async () => {
    const { clave, bulto } = await montar();
    const extendido = new Uint8Array(bulto.length + 8);
    extendido.set(bulto, 0);
    await expect(descifrarFichero(clave, extendido)).rejects.toThrow();
  });

  it("otra clave no abre nada", async () => {
    const { bulto } = await montar();
    await expect(descifrarFichero(nuevaClave(), bulto)).rejects.toThrow();
  });
});

describe("lo que no es un bulto", () => {
  it("un fichero sin cifrar de la era anterior da null, no un error", () => {
    expect(leerPrefijo(new TextEncoder().encode("PDF-1.7 lo que sea..."))).toBeNull();
    expect(leerPrefijo(new Uint8Array(3))).toBeNull();
  });
});
