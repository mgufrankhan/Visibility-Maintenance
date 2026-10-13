import { defineConfig } from 'vite';

/** Local Vite proxies the single-origin layout used in deploy/private/nginx. */
export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2023',
  },
  server: {
    port: 5173,
    proxy: {
      '/api/v1/maintenance': { target: 'http://127.0.0.1:5192', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:5192', changeOrigin: true },
      '/api/v1/identity': { target: 'http://127.0.0.1:5191', changeOrigin: true },
      '/api/v1/assets': { target: 'http://127.0.0.1:5191', changeOrigin: true },
      '/api/v1/meta': { target: 'http://127.0.0.1:5191', changeOrigin: true },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api/v1/maintenance': { target: 'http://127.0.0.1:5192', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:5192', changeOrigin: true },
      '/api/v1/identity': { target: 'http://127.0.0.1:5191', changeOrigin: true },
      '/api/v1/assets': { target: 'http://127.0.0.1:5191', changeOrigin: true },
      '/api/v1/meta': { target: 'http://127.0.0.1:5191', changeOrigin: true },
    },
  },
});
