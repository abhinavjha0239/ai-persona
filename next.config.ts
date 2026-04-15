import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dir,
  },
};

export default nextConfig;
