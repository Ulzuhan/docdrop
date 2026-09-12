import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Go owns HTML and routing. Vite compiles browser assets; no Node server is
// shipped. What the page needs from the deployment (enrol URL, footer links)
// arrives as data attributes on `#app`, put there by Go at request time.
export default defineConfig({
  publicDir: "public",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [{
    name: "docdrop:preserve-placeholder",
    closeBundle() {
      writeFileSync(fileURLToPath(new URL("./internal/web/dist/.gitkeep", import.meta.url)), "");
    },
  }],
  build: {
    outDir: "internal/web/dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: "src/main.tsx" },
  },
});
