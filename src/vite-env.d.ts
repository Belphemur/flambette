/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute `ws(s)://` origin of the live-room relay, when it does NOT
   * live on this origin (ADR-0038: the Cloudflare relay on its own
   * workers.dev/domain). Unset — the default for dev, e2e, LAN and the
   * Docker compose stack — keeps the same-origin `/ws` the proxy serves.
   */
  readonly VITE_RELAY_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, unknown>
  export default component
}
