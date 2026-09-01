import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
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
})
