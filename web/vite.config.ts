import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'MRV_');
  const backendOrigin = `http://127.0.0.1:${env.MRV_WEB_PORT ?? '8022'}`;
  return {
    base: '/static/',
    plugins: [react()],
    resolve: { dedupe: ['react', 'react-dom', 'remotion'] },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      proxy: {
        '/api': backendOrigin,
        '/covers': backendOrigin,
      },
    },
  };
});
