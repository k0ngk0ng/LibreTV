export default function middleware() {
  return new Response('当前账户版 LibreTV 需要 Node.js/Docker 和持久数据目录，不支持 Vercel Serverless 部署。', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
