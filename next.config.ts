import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `serverExternalPackages` sirve para excluir dependencias npm del bundling; listar
  // ahí módulos nativos ("fs", "path", "crypto") no hacía nada, y menos aún subir el
  // límite de subida. El tamaño lo controla /api/upload, que escribe por streaming.

  // Fija la raíz del workspace: hay un package.json suelto en el home que hacía que
  // Next infiriera mal la raíz y avisara en cada build.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
