import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        timeout: 30000,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          antd:   ['antd', '@ant-design/icons'],
          charts: ['recharts'],
          editor: ['@monaco-editor/react'],
          monaco: ['monaco-editor'],
          utils:  ['axios', 'swr', 'zustand', 'dayjs'],
        },
      },
    },
    chunkSizeWarningLimit: 2000,
  },
})
