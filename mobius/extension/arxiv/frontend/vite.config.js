import { defineConfig } from 'vite';
import path from 'path';

// vite 配置: 产物落在 frontend/dist/, 入口为 frontend/index.html.
// 走 /extension/arxiv/ 静态路径, 用相对 base.
export default defineConfig({
  root: path.resolve(__dirname),
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // mobius 在 /extension/_sdk/ext.js 注入 extCall SDK, 编译时不要解析
      external: [/^\/extension\//],
    },
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
  },
});
