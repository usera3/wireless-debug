import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { compression } from 'vite-plugin-compression2'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  define: mode === 'production' ? {
    'import.meta.env.VITE_WS_URL': JSON.stringify(loadEnv(mode, process.cwd(), 'VITE_').VITE_WS_URL || 'ws://192.168.4.1/ws'),
  } : undefined,
  plugins: [
    react(),
    compression({ algorithms: ['gzip'], exclude: /\.(gz|br)$/ }),
  ],
  server: {
    port: 5679,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8766',
      },
      '/excel': {
        target: 'http://localhost:8766',
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // xlsx 单独分包，动态 import 时才加载
        manualChunks: { xlsx: ['xlsx'] },
        entryFileNames: 'a.js',
        chunkFileNames: (chunkInfo) => (chunkInfo.name === 'xlsx' ? 'x.js' : '[name].js'),
        assetFileNames: (assetInfo) => (assetInfo.name?.endsWith('.css') ? 'a.css' : '[name][extname]'),
      },
    },
  },
}))
