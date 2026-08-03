/**
 * Nombre de quien sube, recordado en el navegador.
 *
 * Sirve para saber de quién es cada fichero en la lista cuando varias personas usan
 * el mismo servicio. No es una identidad ni pretende serlo: es una etiqueta que cada
 * uno se pone, igual que el nombre en una carpeta compartida.
 */
const KEY = "docdrop:uploader";

export function getUploaderName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setUploaderName(name: string): void {
  try {
    const clean = name.trim().slice(0, 40);
    if (clean) localStorage.setItem(KEY, clean);
    else localStorage.removeItem(KEY);
  } catch {
    // Modo privado: se pierde entre sesiones, nada más.
  }
}
