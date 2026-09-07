import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const raiz = fileURLToPath(new URL(".", import.meta.url));

// El HTML de producción lo sirve Go, no este `index.html`: aquí sólo se
// construyen los recursos, con nombre por contenido para poder cachearlos
// eternamente. El manifiesto le dice a Go cómo se llaman.
//
// Se construye DESDE `src/`, sin copiar nada: las pantallas y los componentes
// siguen siendo los mismos ficheros que compila Next mientras Node siga siendo
// la referencia de la vuelta atrás. Dos copias del árbol acabarían divergiendo,
// y la que se rompiera en silencio sería justo la que se despliega.
export default defineConfig({
  define: {
    // El pie común está GENERADO desde el repo del tema y lo comparten los seis
    // servicios: no se le cambia la lógica aquí. Lee `process.env`, que en Next
    // es un componente de servidor y aquí no existe — vite sustituye
    // `process.env` por `{}` y la bandera saldría SIEMPRE apagada, perdiendo
    // los enlaces entre servicios sin que nada fallara. Se apunta a lo que deja
    // el servidor en el nodo raíz. Ya pasó en SecretDrop y en QR-Forge.
    "process.env.KAICORP_FOOTER_LINKS":
      "document.getElementById('app')?.dataset.footerLinks",
    "process.env.DOCDROP_ENROLL_URL":
      "document.getElementById('app')?.dataset.enrollUrl",
  },
  root: "web",
  // `public/` está en la raíz del repo, no dentro de `web/`. Vite copia lo que
  // haya aquí a la raíz de `dist`, y así el logo, los iconos de la PWA, la
  // imagen de OpenGraph y el service worker viajan embebidos en el binario.
  publicDir: "../public",
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: join(raiz, "web/src/shim-link.tsx") },
      { find: /^next\/navigation$/, replacement: join(raiz, "web/src/shim-navigation.ts") },
      { find: /^@\//, replacement: join(raiz, "src/") },
    ],
  },
  // SIN `@vitejs/plugin-react`, y no por gusto: ese plugin arrastra un
  // `@babel/core` 8 que choca con el 7 que ya exige `shadcn` en este
  // repositorio, y forzar la resolución dejaría dos Babel distintos en el árbol.
  // Lo único que aporta aquí es Fast Refresh, que es de `vite dev`; el
  // documento de producción lo sirve Go y el desarrollo sigue siendo
  // `npm run dev` con Next mientras Node siga siendo la referencia.
  //
  // El JSX no necesita nada: vite lo transforma él solo en los `.tsx`.
  // Comprobado quitando la configuración que se había puesto por si acaso — el
  // bundle sale con el mismo hash, así que no hacía nada.
  plugins: [
    // `emptyOutDir` vacía el directorio, y ahí dentro vive el único fichero que
    // el repositorio guarda: sin él `go:embed all:dist` no compila en un clon
    // limpio. Se rehace al terminar.
    {
      name: "docdrop:conservar-gitkeep",
      closeBundle() {
        writeFileSync(join(raiz, "internal", "web", "dist", ".gitkeep"), "");
      },
    },
  ],
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: "web/src/main.tsx" },
  },
});
