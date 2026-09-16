import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// The live-room relay runs as a separate process (server/relay.mjs, :8081 in
// dev/e2e, the `relay` service behind nginx in production). Both the dev
// server and `vite preview` (used by the e2e suite) proxy /ws to it so the
// browser only ever talks to the web origin.
const relayProxy = {
  '/ws': {
    target: 'http://localhost:8081',
    ws: true,
  },
}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: { proxy: relayProxy },
  preview: { proxy: relayProxy },
})
