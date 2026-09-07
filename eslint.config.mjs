import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Lo que construye vite y embebe el binario: es salida, no fuente. Sin
    // esto, eslint analiza el bundle minificado y saca cinco «errores» de un
    // código que no hemos escrito.
    "internal/web/dist/**",
  ]),
  {
    // El parámetro que se acepta y se tira a propósito. `next/link` recibía
    // `prefetch` y aquí no hay nada que prebuscar; pasárselo al `<a>` pintaría
    // un atributo inventado, así que se desestructura para descartarlo.
    files: ["web/src/shim-link.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The files in scripts/ are Node scripts and CommonJS on purpose: start.js has
    // to patch http.createServer before loading Next's server, which is CJS.
    files: ["scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
