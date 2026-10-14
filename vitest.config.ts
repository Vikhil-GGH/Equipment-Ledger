import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // Normally injected by vite.config.ts; tests never talk to a real project.
  define: { __PROD_PROJECT_REF__: 'null' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Database tests have their own config (vitest.db.config.ts).
    exclude: [...configDefaults.exclude, 'supabase/**'],
  },
})
