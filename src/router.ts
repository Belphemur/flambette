import { createRouter, createWebHistory } from 'vue-router'
import RecipesTab from './components/RecipesTab.vue'
import PlanTab from './components/PlanTab.vue'
import GroceryTab from './components/GroceryTab.vue'
import HistoryView from './components/HistoryView.vue'
import RecipeDetail from './components/RecipeDetail.vue'
import CookingView from './components/CookingView.vue'
import ShopView from './components/ShopView.vue'
import SettingsTab from './components/SettingsTab.vue'

/**
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
    { path: '/', name: 'recipes', component: RecipesTab },
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
   * Restore the scroll position on back/forward navigations (ADR-0061):
   * vue-router 5 hands us the LEAVING page's offset as `savedPosition` on
   * POP navigations (it records each entry's scroll into history state),
   * so returning it lands the user where they left the list. PUSH
   * navigations (card → detail, logo, tab switches) have no saved
   * position and keep starting at the top.
   */
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})
