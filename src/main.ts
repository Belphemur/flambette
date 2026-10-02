import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { createHead } from '@unhead/vue/client'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// Pinia first: the router's cooking guard reads the plan store.
// Unhead AFTER the router: `App.vue` installs the default head from a
// `useHead` call, and each route component layers its own scoped entries
// on top (ADR-0048). Component entries are removed on unmount, so the
// default resurfaces when you leave a recipe — that is the mechanism the
// seo-head e2e pins.
createApp(App).use(pinia).use(router).use(createHead()).mount('#app')
