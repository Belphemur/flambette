import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { v7 as uuidv7 } from 'uuid'
import { generateDisplayName } from '../lib/roomWords'
import { GUEST_NAME, MAX_NAME_CHARS, sanitizeDisplayName } from '../lib/profileName'
import { useUiStore } from './ui'

/**
 * This device's room identity (ADR-0063).
 *
 * A UUIDv7 id plus an editable display name, generated from curated safe
 * words the first time this device joins or creates a room (and, for
 * devices that upgraded while already in a household, at hydration when
 * the persisted slice is absent but `ui.householdRoom` names a room —
 * identity is a NEW slice, so "absent" is unambiguous).
 *
 * Deliberately DEVICE-scoped, not household state: it never travels in a
 * room snapshot, never merges — but it IS backed up (ADR-0013), because a
 * backup restores whose device this is. Import is therefore
 * replace-on-apply, unlike the reconciling preference slices.
 *
 * The id NEVER regenerates once present — every future "who did this"
 * feature keys on it, so silently re-minting would orphan that history.
 * The name is the only editable half; renames clamp identically to the
 * relay's `normalizeProfile` (one shared sanitizer), so the value the
 * store holds is the value the wire carries.
 */

export interface Identity {
  /** UUIDv7, immutable once generated. '' = not generated yet. */
  id: string
  /** The display name, sanitized to the same 40-visible-char rule. */
  name: string
}

export const IDENTITY_PERSIST_KEY = 'mealime-planner:v1:identity'

export const useIdentityStore = defineStore(
  'identity',
  () => {
    const id = ref('')
    const name = ref('')

    /** True once the device has an identity (id + name both non-empty). */
    const hasIdentity = computed(() => id.value !== '' && name.value !== '')

    /** The name as the roster and the avatar see it (never blank). */
    const displayName = computed(() => name.value || GUEST_NAME)

    /**
     * Generate the identity when absent. Idempotent, and the ONE writer of
     * `id`: a later call with an id present is a no-op, which is what keeps
     * the id immutable across joins, reloads and migrations.
     */
    function generate(): void {
      if (id.value) return
      id.value = uuidv7()
      name.value = generateDisplayName()
    }

    /**
     * The migration path (ADR-0063 §1): a device that already belongs to a
     * household but has no identity slice yet (every pre-ADR-0063 install
     * joining a room on its next launch) mints one at hydration, so the
     * upgrade never shows a room of anonymous peers.
     */
    function ensureIfInRoom(): void {
      if (hasIdentity.value) return
      if (!useUiStore().householdRoom) return
      generate()
    }

    /**
     * Rename. Clamps EXACTLY like the relay's `normalizeProfile` (the one
     * shared sanitizer), so what the store holds is what the wire carries
     * — the Settings field and the roster cannot disagree. Never touches
     * the id. A blank result is refused (the name cannot be emptied).
     */
    function rename(raw: string): void {
      const next = sanitizeDisplayName(raw) || (name.value ? name.value : generateDisplayName())
      if (id.value && name.value && next === name.value) return
      name.value = next
    }

    /**
     * Adopt a validated backup (ADR-0013). Identity is DEVICE-scoped, so
     * import is REPLACE — validation has already run in the registry, so
     * this takes the file's values verbatim (the one writer allowed to
     * set both halves at once).
     */
    function adopt(next: Identity): void {
      id.value = next.id
      name.value = sanitizeDisplayName(next.name) || GUEST_NAME
    }

    return { id, name, hasIdentity, displayName, generate, ensureIfInRoom, rename, adopt }
  },
  {
    persist: {
      key: IDENTITY_PERSIST_KEY,
      pick: ['id', 'name'],
      // Hydration has already run when this fires, so the ui store's
      // persisted `householdRoom` is readable (App.vue instantiates the
      // ui store first). This is the upgrade path's generation moment:
      // a device already in a household mints its identity on the launch
      // after it installs this build.
      afterHydrate: (context) => {
        ;(context.store as unknown as { ensureIfInRoom: () => void }).ensureIfInRoom()
      },
    },
  },
)

/** Max visible chars, re-exported for the Settings field's maxlength. */
export { MAX_NAME_CHARS }
