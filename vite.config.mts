import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Go owns HTML and routing. Vite compiles browser assets; no Node server is shipped.
export default defineConfig({
  define: {
    "process.env.KAICORP_FOOTER_LINKS": "document.getElementById('app')?.dataset.footerLinks",
    "process.env.DOCDROP_ENROLL_URL": "document.getElementById('app')?.dataset.enrollUrl",
  },
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
