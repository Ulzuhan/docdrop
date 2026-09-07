/**
 * `next/navigation`, lo poco que se usaba: `useParams`.
 *
 * El id del fichero y el token del invitado los pone GO en el nodo raíz, ya
 * validados contra el formato que acepta el almacén. Leerlos del `location`
 * aquí sería volver a validarlos en el sitio equivocado.
 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const datos = document.getElementById("app")?.dataset ?? {};
  return { id: datos.fileId ?? "", token: datos.guestToken ?? "" } as unknown as T;
}
