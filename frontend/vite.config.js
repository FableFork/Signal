import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy — not used in Docker (nginx handles routing there)
const BACKEND_PORT = process.env.BACKEND_PORT || '8001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${BACKEND_PORT}`,
      '/ws': { target: `ws://localhost:${BACKEND_PORT}`, ws: true },
    },
  },
})
