import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 100000000, cssCodeSplit: false },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'] },
});
