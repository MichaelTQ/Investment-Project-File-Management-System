import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 这几个包只在服务端按需加载，交给 Node 运行时直接 require，不进构建产物。
  //
  // pdfjs-dist：只在解析带文字层的 PDF 时用到，避免构建器把数 MB 的解析器编入
  // 每个 API route。
  //
  // @langchain/*：深挖旁路的第二套编排（graph.ts）才会用到，默认那套手写循环根本
  // 不碰它。**更要紧的是：它不该有能力让整个产品编译失败。** 一个只在对照实验里
  // 用的可选编排，被构建器当成硬依赖静态解析，依赖没装上就整站起不来——这是它
  // 第一次上线时踩到的坑。标成 external 之后，装没装都只影响深挖那一条路。
  serverExternalPackages: ['pdfjs-dist', '@langchain/langgraph', '@langchain/core'],
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
