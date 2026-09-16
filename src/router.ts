import { createRouter, createWebHistory } from 'vue-router'
import RecipesTab from './components/RecipesTab.vue'
import PlanTab from './components/PlanTab.vue'
import GroceryTab from './components/GroceryTab.vue'
import RecipeDetail from './components/RecipeDetail.vue'
import CookingView from './components/CookingView.vue'
import ShopView from './components/ShopView.vue'
import { usePlanStore } from './stores/plan'

/**
 * Deep-linkable navigation. `/cooking/:id` is gated on plan membership —
 * cooking is a plan-driven mode, so a direct link to a recipe that isn't in
 * the plan falls back to the recipe detail view.
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'recipes', component: RecipesTab },
    { path: '/plan', name: 'plan', component: PlanTab },
    { path: '/grocery', name: 'grocery', component: GroceryTab },
    { path: '/shop', name: 'shop', component: ShopView },
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
        const plan = usePlanStore()
        const id = Number(to.params.id)
        if (!Number.isFinite(id) || !plan.planContains(id)) {
          return { name: 'recipe', params: { id: to.params.id }, replace: true }
        }
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})
