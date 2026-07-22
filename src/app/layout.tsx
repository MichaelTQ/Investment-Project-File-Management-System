import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '投资项目档案管理系统',
    template: '%s | 国创致远',
  },
  description:
    '智能投资项目档案管理系统，基于国创致远档案管理规范，实现文件自动分类与归档。',
  keywords: [
    '投资项目',
    '档案管理',
    '文件分类',
    '智能归档',
    '国创致远',
    '投后管理',
    '尽职调查',
  ],
  authors: [{ name: '国创致远', url: 'https://code.coze.cn' }],
  generator: 'Coze Code',
  openGraph: {
    title: '投资项目档案管理系统 | 国创致远',
    description:
      '智能投资项目档案管理系统，基于国创致远档案管理规范，实现文件自动分类与归档。',
    locale: 'zh_CN',
    type: 'website',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="en">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
