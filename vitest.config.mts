import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // Node a secas: el módulo de cifrado usa WebCrypto por `globalThis.crypto`,
    // que en Node ≥20 es la misma API que en el navegador — probar aquí es
    // probar lo que corre allí.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
