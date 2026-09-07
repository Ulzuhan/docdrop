/**
 * `next/link` era un `<a>` con prebúsqueda. Sin router no hay nada que
 * prebuscar, así que es un `<a>`: estas rutas las sirve Go y una navegación de
 * verdad es lo que las carga con la sesión ya resuelta.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({
  href,
  children,
  prefetch: _prefetch,
  ...resto
}: { href: string; children?: ReactNode; prefetch?: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  // `prefetch` se acepta y se tira: los componentes vienen del árbol de Next y
  // pasárselo al `<a>` sólo pintaría un atributo inventado.
  return (
    <a href={href} {...resto}>
      {children}
    </a>
  );
}
