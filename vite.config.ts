import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'frontend',
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: '../public/admin',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/admin': 'http://127.0.0.1:8790',
      '/health': 'http://127.0.0.1:8790',
      '/oauth': 'http://127.0.0.1:8790',
      '/callback': 'http://127.0.0.1:8790',
    },
  },
})
