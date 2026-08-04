import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PDF.js 只在服务端按需解析带文字层的 PDF；让 Node 运行时直接加载，
  // 避免构建器把数 MB 的解析器编入每个 API route。
  serverExternalPackages: ['pdfjs-dist'],
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
