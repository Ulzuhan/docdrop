/**
 * Uploader name, remembered in the browser.
 *
 * Lets you tell whose file is whose in the listing when several people share the
 * same service. It is not an identity and does not try to be: it is a label each
 * person sets for themselves, like a name on a shared folder.
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
    // Private mode: it is lost between sessions, nothing more.
  }
}
