import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig, loadEnv } from 'vite'

// Port used only by `npm run dev:staging`, so staging runs on its own
// browser origin (separate saved logins, never the production app's tab).
const STAGING_PORT = 5180

function projectRef(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url ?? '')
  return m ? m[1] : null
}

/**
 * Staging gate #1 (gate #2 is src/lib/supabaseConfig.ts in the browser):
 * staging mode starts only if .env.staging.local has its own staging
 * settings and none of them point at the production project in .env.
 */
function checkStagingEnv(root: string): void {
  const file = resolve(root, '.env.staging.local')
  if (!existsSync(file)) {
    throw new Error('Staging mode needs .env.staging.local — see docs/STAGING_SETUP.md, step 4.')
  }
  const staging = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]),
  )
  for (const key of ['VITE_STAGING_SUPABASE_URL', 'VITE_STAGING_SUPABASE_ANON_KEY']) {
    if (!staging[key] || /your-|</.test(staging[key])) {
      throw new Error(`Staging mode: ${key} is missing or still a placeholder in .env.staging.local.`)
    }
  }
  const prodRef = projectRef(loadEnv('production', root, 'VITE_').VITE_SUPABASE_URL)
  if (!prodRef) throw new Error('Staging mode: could not read the production project from .env. Refusing to start.')
  if (Object.values(staging).some((v) => v.includes(prodRef))) {
    throw new Error('Staging mode: .env.staging.local refers to the PRODUCTION project. Refusing to start.')
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const root = process.cwd()
  const isStaging = mode === 'staging'
  if (isStaging && command === 'build') {
    throw new Error('Staging builds are disabled: staging is for local testing only and must never be deployed.')
  }
  if (isStaging) checkStagingEnv(root)

  return {
    define: {
      __PROD_PROJECT_REF__: JSON.stringify(projectRef(loadEnv('production', root, 'VITE_').VITE_SUPABASE_URL)),
    },
    server: isStaging ? { port: STAGING_PORT, strictPort: true } : undefined,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Equipment Ledger',
          short_name: 'Equip Ledger',
          description: 'GroundGame Health equipment and accessory tracking.',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // Precaches only the build-time app shell (JS/CSS/HTML/icons) so it
          // can boot offline. No runtimeCaching rules are added for Supabase
          // calls — they're cross-origin fetches to the project URL, so
          // Workbox never touches them; every ledger read/write always hits
          // the network live. A stale offline copy of RLS-gated data would
          // be actively misleading, so this is deliberate, not an oversight.
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        },
      }),
    ],
  }
})
