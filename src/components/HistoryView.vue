<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ChefHat } from 'lucide-vue-next'
import { catalog } from '../lib/catalog'
import { formatAbsolute, formatRelative, useCookHistory } from '../lib/history'
import { imageSrc, onImgError } from '../lib/images'
import type { VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const plan = usePlanStore()
const ui = useUiStore()
const cooked = useCookHistory()

/** Catalog meta attached to each aggregated row (missing recipes drop). */
interface Row {
  variantId: number
  count: number
  lastAt: number
  meta: VariantMeta
}

/**
 * The cook events grouped by the plan they were cooked under, most recent
 * plan first (ADR-0034). A NEW read-side view, not a second storage: the
 * per-recipe rows above are the same events aggregated by recipe, and both
 * views are derived from `plan.cookedHistory`. A recipe cooked in two plans
 * legitimately appears under both.
 */
interface Group {
  key: string
  planId: string | null
  planCreatedAt: number | null
  lastAt: number
  count: number
  rows: Row[]
}

const groups = computed<Group[]>(() => {
  const c = catalog.value
  if (!c) return []
  return cooked.planGroups.value.map((g) => {
  const rows = g.entries.flatMap((e) => {
  const meta = c.byId.get(e.variantId)
  return meta ? [{ ...e, meta }] : []
  })
  return {
  key: g.planId ?? 'earlier-cooks',
  planId: g.planId,
  planCreatedAt: g.planCreatedAt,
  lastAt: g.lastAt,
  count: g.events.length,
  // A group whose recipes all left the catalog renders nothing; drop
  // it rather than showing an empty heading.
  rows,
  }
  }).filter((g) => g.rows.length > 0)
})

/** "Planned 3 days ago" / "Earlier cooks" heading for one group. */
function groupTitle(g: Group): string {
  if (g.planCreatedAt === null) return g.planId ? 'Cooked plan' : 'Earlier cooks'
  return `Planned ${formatRelative(g.planCreatedAt)}`
}

function openRecipe(id: number) {
  void router.push({ name: 'recipe', params: { id: String(id) } })
}

/** Re-plan the meal at the remembered default servings (ADR-0037) — same
 *  flow as the detail view, and no per-recipe stepper is offered here, so
 *  this is the only sensible count. Was the authored `serving_count`. */
function addToPlan(row: Row) {
  plan.addToPlan(row.meta, ui.defaultServings)
  ui.showToast(`Added ${row.meta.name} to plan`)
}
</script>

<template>
  <section class="space-y-3" aria-label="Cooking history">
  <p class="text-xs text-text-muted" data-test="history-sync-note">
  Shared with your household by default — every phone in the room contributes to one cooking log, and histories
  merge rather than overwrite each other. Turn off
  <strong>“Sync cooked history”</strong> in Settings → Household sync to stop sharing new cooks — cooks shared
  earlier stay in the room, so this controls what goes out from here, not what has already been shared.
  </p>

  <div
  v-if="groups.length === 0"
  class="py-16 text-center text-text-muted"
  data-test="history-empty"
  >
  <ChefHat :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">Nothing cooked yet</p>
  <p class="mt-1 text-sm">Mark meals as cooked when you finish them.</p>
  <button
  class="mt-4 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand"
  @click="router.push('/')"
  >
  Browse recipes
  </button>
  </div>

  <div v-else class="space-y-5">
  <section
  v-for="group in groups"
  :key="group.key"
  class="space-y-2"
  :data-test="group.planId ? `history-group-${group.planId}` : 'history-group-legacy'"
  >
  <!-- What plan this batch was, and when it was put together
  (ADR-0034). The absolute date lives in the title: the
  relative one is the one that reads well in a list. -->
  <!-- ADR-0055: the absolute date lives in the bubble now (hover only —
  the h2 is not focusable, same parity the native title had). -->
  <h2
  class="group relative flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
  data-test="history-group-title"  >
  {{ groupTitle(group) }}
  <TooltipBubble
  :text="group.planCreatedAt === null ? '' : `Planned ${formatAbsolute(group.planCreatedAt)}`"
  placement="below-right"
  />
  <span class="font-normal normal-case">
  {{ group.count === 1 ? '1 cook' : `${group.count} cooks` }}
  </span>
  </h2>
  <ul class="space-y-2">
  <li
  v-for="row in group.rows"
  :key="`${group.key}-${row.variantId}`"
  class="flex items-center gap-3 rounded-xl bg-surface-raised p-2.5 ring-1 ring-border"
  data-test="history-row"
  >
  <img
  :src="imageSrc(row.meta.thumbnail_image_url)"
  :alt="row.meta.name"
  loading="lazy"
  class="size-16 shrink-0 hovercap:cursor-pointer rounded-lg object-cover"
  @error="onImgError"
  @click="openRecipe(row.variantId)"
  />
  <div class="min-w-0 flex-1 hovercap:cursor-pointer" @click="openRecipe(row.variantId)">
  <h3 class="line-clamp-2 text-sm font-semibold">{{ row.meta.name }}</h3>
  <p
  class="group relative mt-0.5 text-xs text-text-muted"
  >
  <TooltipBubble :text="formatAbsolute(row.lastAt)" placement="below-right" />
  <span
  class="mr-1 rounded bg-brand/10 px-1.5 py-px text-[10px] font-bold text-brand-text"
  :data-test="`history-count-${row.variantId}`"
  >
  {{ row.count === 1 ? 'cooked once' : `cooked ${row.count} times` }}
  </span>
  {{ formatRelative(row.lastAt) }}
  </p>
  </div>
  <button
  class="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-brand-text hover:bg-surface"
  :aria-label="`Add ${row.meta.name} to plan`"
  :data-test="`history-add-${row.variantId}`"
  @click="addToPlan(row)"
  >
  Add to plan
  </button>
  </li>
  </ul>
  </section>
  </div>
  </section>
</template>
