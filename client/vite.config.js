import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // amazon-cognito-identity-js expects Node's `global`.
  define: {
    global: 'globalThis',
  },
  // Dev only: forward /api to the Tier 2 server.
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
      // Custom service worker, see src/sw/sw.js.
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