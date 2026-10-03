import { defineConfig } from '@solidjs/start/config';

export default defineConfig({
  server: { port: 62025 },
  vite: { server: { host: '0.0.0.0' } }
});
