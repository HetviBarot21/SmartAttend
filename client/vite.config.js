import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // amazon-cognito-identity-js references the Node `global` object, which does
  // not exist in the browser and throws "global is not defined" on load.
  define: {
    global: 'globalThis',
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
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'SmartAttend AI',
        short_name: 'SmartAttend',
        description: 'Offline-first student attendance management system',
        theme_color: '#064F60',
        background_color: '#064F60',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
    })
  ],
})