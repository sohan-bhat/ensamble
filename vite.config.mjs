import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev, Vite serves the React app on :5173. API + SSE requests are
// proxied to the Express server on :3000.
// In production, `npm run build` emits dist/, which Express then serves.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
