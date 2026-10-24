import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './components/HomeView.vue'
import RecipesTab from './components/RecipesTab.vue'
import PlanTab from './components/PlanTab.vue'
import GroceryTab from './components/GroceryTab.vue'
import HistoryView from './components/HistoryView.vue'
import RecipeDetail from './components/RecipeDetail.vue'
import CookingView from './components/CookingView.vue'
import ShopView from './components/ShopView.vue'
import SettingsTab from './components/SettingsTab.vue'
import { hasUsedApp } from './lib/usedApp'
import { useUiStore } from './stores/ui'
import { usePlanStore } from './stores/plan'
import { useRoomStore } from './stores/room'

/**
 * Route-table shape (ADR-0078 + ADR-0096):
 *
 *  - `/` (name `home`) is the home HERO for NEW visitors — a statement of
 *    what the app is, not a dense grid. A `beforeEnter` guard replaces a
 *    RETURNING device (`hasUsedApp`: a plan, a live room, or a saved
 *    household room) onto the recipes list, because for someone who has
 *    used the app their home IS the working surface. The query is carried
 *    through, so a `?room=` link join survives the redirect.
 *  - `/welcome` (name `welcome`) is the hero's always-accessible home:
 *    every surface is reachable from here, even after the redirect retires
 *    the hero from `/`.
 *  - `/recipes` (name `recipes`) is the catalog grid; every
 *    `router.push({ name: 'recipes' })` (the freshJoin landing watcher, the
 *    post-join landing, tab targets) keeps working unchanged.
 *  - `/:pathMatch(.*)*` redirects to `/`; a returning device is then sent
 *    to `/recipes`, a new one to the hero.
 *
 * Deep-linkable navigation. `/cooking/:id` is open to ANY recipe in the
 * catalog (ADR-0034): cooking needs nothing from the plan but a servings
 * number, and CookingView already falls back to the recipe's own
 * `serving_count`, so the plan-membership gate only made deep links and
 * "Start cooking" from the Recipes tab bounce. Only a non-numeric id is
 * refused, and it lands on the detail view, which owns the not-found state.
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
      beforeEnter: (to) => {
        // ADR-0096 Decision 2: a returning device is REPLACED onto the recipes
        // list (their home IS the working surface), carrying the incoming
        // query so a `?room=` link join is not eaten. The stores are read
        // lazily here: pinia is installed before the router in main.ts, and
        // pinia-plugin-persistedstate restores persisted state synchronously
        // on first store access, so `householdRoom`/`plan` are hydrated
        // before the redirect decision is made. A new device falls through
        // to the hero.
        const ui = useUiStore()
        const plan = usePlanStore()
        const room = useRoomStore()
        if (hasUsedApp(plan.plan.length, room.inRoom, ui.householdRoom, room.resumableRoomCode)) {
          return { name: 'recipes', query: to.query, replace: true }
        }
      },
    },
    { path: '/welcome', name: 'welcome', component: HomeView },
    { path: '/recipes', name: 'recipes', component: RecipesTab },
    { path: '/plan', name: 'plan', component: PlanTab },
    { path: '/history', name: 'history', component: HistoryView },
    { path: '/grocery', name: 'grocery', component: GroceryTab },
    { path: '/shop', name: 'shop', component: ShopView },
    { path: '/settings', name: 'settings', component: SettingsTab },
    {
      path: '/recipe/:id',
      name: 'recipe',
      component: RecipeDetail,
      props: (route) => ({ id: Number(route.params.id) }),
    },
    {
      path: '/cooking/:id',
      name: 'cooking',
      component: CookingView,
      props: (route) => ({ id: Number(route.params.id) }),
      beforeEnter: (to) => {
        const id = Number(to.params.id)
        if (!Number.isFinite(id)) {
          return { name: 'recipe', params: { id: to.params.id }, replace: true }
        }
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  /**
   * Restore the scroll position on back/forward navigations (ADR-0062):
   * on a POP navigation vue-router 5 hands us `savedPosition` — the
   * scroll offset recorded in the DESTINATION entry's history state when
   * we last left it — so returning it lands the user where they left the
   * list. PUSH navigations (card → detail, logo, tab switches) have no
   * saved position and keep starting at the top.
   */
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})
