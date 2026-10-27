import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// 前端源码在根目录的 src/，与 Python 后端同级。
// dev 模式下 Vite 起在 18731，把所有后端路径（含 WebSocket）代理到 127.0.0.1:18732，
// 这样前端仍然只跟 location.host 打交道，无需关心后端端口。
const API_PORT = 18732
const BACKEND = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 18731,
    strictPort: true,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
      '/config': BACKEND,
      '/agent': BACKEND,
      '/login': BACKEND,
      '/connect': BACKEND,
      '/disconnect': BACKEND,
      '/history': BACKEND,
      '/dm': BACKEND,
      '/window': BACKEND,
      '/capabilities': BACKEND,
      '/generated-images': BACKEND,
      '/stage': BACKEND,
    },
  },
})
