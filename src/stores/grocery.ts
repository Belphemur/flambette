import { reactive, watch } from 'vue'
import { load, save } from '../lib/storage'

/**
 * Grocery checkbox state, keyed by grocery line key. Persisted to
 * localStorage under the app namespace.
 */
export const checked = reactive({
  map: load<Record<string, boolean>>('checked', {}),
})

watch(
  () => checked.map,
  (m) => save('checked', m),
  { deep: true },
)

export function isChecked(key: string): boolean {
  return checked.map[key] === true
}

export function toggleChecked(key: string): void {
  if (checked.map[key]) delete checked.map[key]
  else checked.map[key] = true
}

export function clearChecked(): void {
  checked.map = {}
}
