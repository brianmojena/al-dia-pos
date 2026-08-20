import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // Convierte la web en instalable ("Añadir a pantalla de inicio" en
    // Android/iOS) y cachea el shell de la app para que abra sin red. Es el
    // mismo modelo de distribución informal que ya usamos con el .exe/.dmg
    // por USB: no requiere Play Store ni cuenta de desarrollador.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Mi Tienda — POS',
        short_name: 'Mi Tienda',
        description: 'Punto de venta e inventario para MIPYMES cubanas',
        theme_color: '#007AFF',
        background_color: '#F5F5F7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/pos',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // El shell (JS/CSS/HTML) se precachea al instalar el service worker.
        // Las llamadas a /api/* NO se cachean con estrategia genérica: la
        // cola de ventas offline (src/lib/salesQueue.js) las maneja a mano,
        // así que aquí solo dejamos pasar la red y no interferimos.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\/products$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'products-cache',
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
