import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow large file uploads (up to 10GB)
  serverExternalPackages: ["fs", "path", "crypto"],
};

export default nextConfig;