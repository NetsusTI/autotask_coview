import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Los entrypoints de la extensión usan los auto-imports de WXT (defineContentScript,
    // defineBackground...) que solo existen durante su build, así que no son testeables
    // desde acá. Sus módulos puros de lib/ sí lo son — de ahí que la exclusión apunte a
    // entrypoints/ y no a todo ticket_lock_wxt/.
    exclude: [
      '**/node_modules/**',
      '**/ticket_lock_wxt/entrypoints/**',
      '**/ticket_lock_wxt/.output/**',
      '**/ticket_lock_wxt/.wxt/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
