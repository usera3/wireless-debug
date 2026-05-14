import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5679,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // xlsx 单独分包，动态 import 时才加载
        manualChunks: { xlsx: ['xlsx'] },
      },
    },
  },
})