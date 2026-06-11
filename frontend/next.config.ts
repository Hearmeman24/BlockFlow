import type { NextConfig } from "next";

const backendPort = process.env.BACKEND_PORT || "8000";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    externalDir: true,
    // Block upload endpoints (video_loader etc.) stream raw file bytes
    // through the /api rewrite; the proxy's default 10MB body cap truncates
    // larger videos mid-request.
    proxyClientMaxBodySize: "100mb",
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
