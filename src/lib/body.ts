/**
 * El cuerpo de una petición, leído como objeto.
 *
 * Las dos rutas que leen JSON lo hacían dentro de un `try`, que cubre el caso
 * evidente —un cuerpo que no es JSON hace lanzar a `json()`— pero no el
 * traicionero: el texto `null` es JSON perfectamente válido, así que `json()` no
 * protesta y devuelve `null`; el `catch` no se entera y quien luego lee
 * `body.filename` se lleva un TypeError. Medido: `null` daba 500 en las dos.
 *
 * Las listas tampoco valen. `/api/guest-links` aceptaba `[1,2]` y creaba el
 * enlace con todo por defecto, que es aceptar una petición sin sentido en vez de
 * decir que no se entiende.
 *
 * Y se exige `application/json`. Los cinco servicios de este dominio son el MISMO
 * sitio para el navegador, así que la cookie de sesión viaja en una petición
 * lanzada desde una página de cualquiera de ellos; el navegador sólo deja salir
 * una petición a otro sitio sin preguntar antes si el tipo es `text/plain`,
 * `multipart/form-data` o el de un formulario. Con `application/json` está
 * obligado a preguntar, y esa pregunta aquí no se contesta.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function jsonBody(request: Request): Promise<any | null> {
  const tipo = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(tipo.trim())) return null;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}
