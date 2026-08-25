import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    // The dashboard calls `/api/...` with no host, in development and in
    // production alike. The proxy is what makes that true locally, and it
    // means no environment-specific base URL ever has to exist in the client
    // — one less thing to configure wrongly on a deploy.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3100',
        changeOrigin: true,
      },
    },
  },
});
