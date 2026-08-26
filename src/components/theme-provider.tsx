"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * `nonce` no es opcional por comodidad: next-themes inyecta un script en línea
 * que corre antes de pintar para que no haya un fogonazo del tema equivocado.
 * Con la CSP por nonce, ese script es el único de la página que no lo lleva
 * puesto por Next, así que sin pasárselo el navegador lo bloquea y el tema se
 * aplica tarde. Viene de la cabecera `x-nonce` que pone src/proxy.ts.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      nonce={nonce}
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
