import type { NextConfig } from "next";

const backendPort = process.env.BACKEND_PORT || "8000";

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${backendPort}/api/:path*`,
      },
      {
        source: "/outputs/:path*",
        destination: `http://127.0.0.1:${backendPort}/outputs/:path*`,
      },
    ];
  },
};

export default nextConfig;
