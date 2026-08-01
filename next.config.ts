import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 固定 Turbopack 的 workspace 根目录为项目目录，
  // 避免 Next.js 向上查找到沙箱环境根目录的 /pnpm-lock.yaml 而误判根目录
  turbopack: {
    root: process.cwd(),
  },
  /* config options here */
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
