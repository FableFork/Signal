import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dev proxy — not used in Docker (nginx handles routing there)
const BACKEND_PORT = process.env.BACKEND_PORT || '8001'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['react-globe.gl'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${BACKEND_PORT}`,
      '/ws': { target: `ws://localhost:${BACKEND_PORT}`, ws: true },
    },
  },
})
