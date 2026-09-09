import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // amazon-cognito-identity-js references the Node `global` object, which does
  // not exist in the browser and throws "global is not defined" on load.
  define: {
    global: 'globalThis',
  },
  // Dev-only: forward every /api request to the Tier 2 Express server so the
  // PWA's sync/data calls (e.g. syncService.js -> POST /api/sync) reach it
  // instead of 404ing against the Vite dev server.
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // Custom service worker (src/sw/sw.js) so the outbound Background Sync
      // queue in src/workers/syncQueue.js can live inside the worker.
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
      includeAssets: ['favicon.svg', 'favicon-96x96.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'SmartAttend AI',
        short_name: 'SmartAttend',
        description: 'Offline-first student attendance management system',
        theme_color: '#f6f7fb',
        background_color: '#f6f7fb',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
    })
  ],
})