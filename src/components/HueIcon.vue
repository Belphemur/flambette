<script setup lang="ts">
import type { Component } from 'vue'
import { Beef, Droplet, Fish, Flame, Vegan } from 'lucide-vue-next'
import { hueClass, type IconRole } from '../lib/palette'

/**
 * One icon per colour role (ADR-0035): the categorical ingredient-type
 * hues and the semantic nutrition hues, always worn as the matching
 * DESIGN.md token via `hueClass`. Icons are decorative here — the label
 * beside them carries the meaning — so they stay `aria-hidden` (ADR-0029).
 */
const props = withDefaults(defineProps<{ role: IconRole; size?: number }>(), { size: 16 })

const ICONS: Record<IconRole, Component> = {
  meat: Beef,
  fish: Fish,
  vegan: Vegan,
  energy: Flame,
  sodium: Droplet,
}
</script>

<template>
  <component
    :is="ICONS[props.role]"
    :size="props.size"
    :class="hueClass(props.role)"
    aria-hidden="true"
  />
</template>