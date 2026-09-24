<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGroceryList } from '../lib/useGroceryList'
import { usePlanStore } from '../stores/plan'

const plan = usePlanStore()
const router = useRouter()
const { checked, loadError, loading, items, totalCount, checkedCount, sections, ensureDocs, confirmAndClearGrocery } =
  useGroceryList()

/* ---------- Custom (free-form) grocery items ---------- */

const newItem = ref('')

function addNewItem() {
  if (plan.addCustomItem(newItem.value)) {
    newItem.value = ''
  }
}
</script>

<template>
  <section class="space-y-3">
    <div
      v-if="plan.plan.length === 0 && plan.customItems.length === 0"
      class="py-16 text-center text-stone-400"
    >
      <p class="text-4xl">🛒</p>
      <p class="mt-2 font-medium">Nothing to buy yet</p>
      <p class="mt-1 text-sm">Add meals to your plan and the grocery list builds itself.</p>
      <button
        class="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
        @click="router.push('/')"
      >
        Browse recipes
      </button>

      <form class="mx-auto mt-6 flex max-w-sm gap-2" data-test="add-item-form" @submit.prevent="addNewItem">
        <input
          v-model="newItem"
          type="text"
          maxlength="80"
          placeholder="Add an item not in the recipes…"
          aria-label="Add a custom grocery item"
          class="h-11 w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 px-4 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          class="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="newItem.trim().length === 0"
        >
          Add
        </button>
      </form>
    </div>

    <template v-else-if="loading && items.length === 0">
      <div class="space-y-2" aria-busy="true">
        <div v-for="i in 6" :key="i" class="h-10 animate-pulse rounded-lg dark:bg-stone-700" />
      </div>
    </template>

    <div v-else-if="loadError" class="rounded-xl dark:bg-rose-950 p-4 text-center text-sm dark:text-rose-300">
      <p class="font-medium">Couldn't build the grocery list</p>
      <p class="mt-1 text-xs">{{ loadError }}</p>
      <button class="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-white" @click="ensureDocs">Retry</button>
    </div>

    <template v-else>
      <!-- Meals planned but every ingredient cleared (phase 9) -->
      <div
        v-if="totalCount === 0 && plan.plan.length > 0"
        class="py-16 text-center text-stone-400"
        data-test="cleared-empty"
      >
        <p class="text-4xl">🧹</p>
        <p class="mt-2 font-medium">All ingredients cleared.</p>
        <p class="mt-1 text-sm">They'll come back when you plan new recipes.</p>
      </div>

      <template v-else>
        <button
          class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-bold text-white shadow-sm active:bg-primary-dark"
          data-test="start-shopping"
          @click="router.push('/shop')"
        >
          🛒 Start shopping
        </button>

        <div
          class="sticky top-12 z-10 -mx-4 flex items-center justify-between border-b dark:border-stone-700 dark:bg-stone-950/95 px-4 py-2 backdrop-blur"
        >
          <p class="text-sm font-semibold" aria-live="polite">
            {{ checkedCount }} / {{ totalCount }} items
          </p>
          <div class="h-1.5 w-24 overflow-hidden rounded-full dark:bg-stone-700">
            <div
              class="h-full rounded-full bg-primary transition-all"
              :style="{ width: totalCount ? `${(checkedCount / totalCount) * 100}%` : '0%' }"
            />
          </div>
          <button
            v-if="checkedCount > 0"
            class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium dark:text-stone-400 dark:hover:bg-stone-700"
            data-test="clear-list"
            aria-label="Clear grocery list"
            @click="confirmAndClearGrocery()"
          >
            ♻️ Clear list
          </button>
        </div>
      </template>

      <form class="flex gap-2" data-test="add-item-form" @submit.prevent="addNewItem">
        <input
          v-model="newItem"
          type="text"
          maxlength="80"
          placeholder="Add an item not in the recipes…"
          aria-label="Add a custom grocery item"
          class="h-11 w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 px-4 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          class="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="newItem.trim().length === 0"
        >
          Add
        </button>
      </form>

      <div
        v-if="plan.customItems.length > 0"
        class="space-y-1.5"
        data-test="custom-items"
      >
        <h3 class="px-1 pt-2 text-xs font-bold tracking-wider text-stone-400 uppercase">
          Extra items
        </h3>
        <ul class="divide-y dark:divide-stone-800 rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700">
          <li
            v-for="item in plan.customItems"
            :key="item"
            class="flex min-h-11 items-center gap-3 px-3 py-2"
          >
            <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                class="size-5 shrink-0 accent-primary"
                :checked="!!checked.map[`custom||${item.toLowerCase()}`]"
                @change="checked.toggleChecked(`custom||${item.toLowerCase()}`)"
              />
              <span
                class="min-w-0 truncate text-sm"
                :class="checked.map[`custom||${item.toLowerCase()}`] ? 'text-stone-400 line-through' : ''"
              >{{ item }}</span>
            </label>
            <button
              class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-rose-600"
              :aria-label="`Remove ${item} from the grocery list`"
              @click="plan.removeCustomItem(item)"
            >
              ✕
            </button>
          </li>
        </ul>
      </div>

      <div v-for="section in sections" :key="section.name" class="space-y-1.5">
        <h3 class="px-1 pt-2 text-xs font-bold tracking-wider text-stone-400 uppercase">
          {{ section.name }}
        </h3>
        <ul class="divide-y dark:divide-stone-800 rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700">
          <li v-for="item in section.items" :key="item.normalized">
            <div
              v-for="line in item.lines"
              :key="line.key"
              class="flex min-h-11 items-center gap-3 px-3 py-2"
            >
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  class="size-5 shrink-0 accent-primary"
                  :checked="!!checked.map[line.key]"
                  @change="checked.toggleChecked(line.key)"
                />
                <span
                  class="min-w-0 flex-1 truncate text-sm"
                  :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                >
                  <span
                    v-if="line.display"
                    class="mr-1.5 font-medium text-primary-dark"
                    :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                  >{{ line.display }}</span>
                  <span :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''">{{ item.name }}</span>
                </span>
                <!-- Provenance pill: a shrink-0 flex sibling OUTSIDE the
                     truncating span, so the tooltip is never clipped by the
                     name's overflow and the pill can never crowd the text
                     (or the checkbox, which sits at the row's far left). -->
                <span
                  v-if="item.recipes.length > 1"
                  class="group/pill relative inline-flex shrink-0"
                  data-test="provenance-pill"
                  @click.stop
                >
                  <span
                    tabindex="0"
                    role="note"
                    :aria-label="`Used by ${item.recipes.length} planned meals: ${item.recipes.join(', ')}`"
                    class="cursor-help whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary-dark outline-none focus-visible:ring-2 focus-visible:ring-primary dark:bg-primary/20 dark:text-primary"
                  >{{ item.recipes.length }} recipes</span>
                  <span
                    class="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden w-56 rounded-lg bg-stone-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg group-hover/pill:block group-focus-within/pill:block dark:bg-stone-700"
                  >
                    <span class="block font-semibold">Used by {{ item.recipes.length }} planned meal{{ item.recipes.length === 1 ? '' : 's' }}:</span>
                    {{ item.recipes.join(', ') }}
                  </span>
                </span>
              </label>
            </div>
          </li>
        </ul>
      </div>

      <p class="pt-2 pb-4 text-center text-xs text-stone-400">
        {{ plan.plan.length }} meal{{ plan.plan.length === 1 ? '' : 's' }} ·
        {{ items.length }} ingredients shown
      </p>
    </template>
  </section>
</template>
