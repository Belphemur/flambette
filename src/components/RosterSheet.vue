<script setup lang="ts">
import AppModal from './AppModal.vue'
import PersonAvatar from './PersonAvatar.vue'
import { computed } from 'vue'
import { Share2, Users, X } from 'lucide-vue-next'
import type { RosterMember } from '../stores/room'
import { useShareRoomLink } from '../composables/useShareRoomLink'

/**
 * The room roster sheet (ADR-0063, DESIGN.md "Person avatars and the room
 * roster"; ADR-0079 names the room and carries the share action).
 *
 * Opened by tapping the header's live room chip — the chip is the door.
 * The header states the RELAY's live count ("N in room"); each row is the
 * member's avatar + name (Title Case, `body-sm`) with a quiet text "you"
 * marker on this device's own row — text, never a colour-only
 * distinction.
 *
 * ADR-0079: the sheet is the room's INFO surface, not just its people
 * list — it names the room (the code, in the data voice) and carries the
 * "Share room link" action through `useShareRoomLink()` (ADR-0023:
 * verified write, always says something, never a raw clipboard call).
 * The chip itself has no tooltip any more; this sheet is where room
 * information lives.
 *
 * This is a PEOPLE list (deduped relay-side by profile id), NOT a socket
 * list: the badge may say 3 while the sheet lists 2, because one device
 * with two tabs is one person. Presence is the relay's live truth — who
 * is CONNECTED NOW, never who has ever been in the household — and EMPTY
 * roster data (`members === null`: an old relay that sends no `members`)
 * degrades to the plain count. The sheet NEVER invents a fake member
 * list, never ranks, never gamifies presence.
 */

const props = defineProps<{
  /** The relay's live headcount of SOCKETS (the badge's number). */
  count: number | null
  /** The roster rows, or null when no relay has told us yet. */
  members: RosterMember[] | null
  /** THIS device's profile id — the row that gets the "you" marker. */
  selfId: string | null
  /** The room's code — the room's NAME (ADR-0079). */
  code: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const heading = computed(() => {
  const n = props.count
  if (n === null) return 'Who is in the room'
  return n === 1 ? '1 in room' : `${n} in room`
})

/** ADR-0023: the ONLY path a room link ever takes to the clipboard. */
const { shareRoomLink } = useShareRoomLink()

function share() {
  void shareRoomLink(props.code)
}
</script>

<template>
  <AppModal
    dialog-label="People in this room"
    overlay-class="z-50 flex items-end justify-center modal-scrim p-0 sm:items-center"
    panel-class="mx-auto max-w-app w-full rounded-t-2xl bg-surface p-4 pb-8 sm:rounded-2xl"
    panel-test="roster-sheet"
    @close="emit('close')"
  >
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-lg font-bold tracking-tight" data-test="roster-heading">
        <Users :size="18" aria-hidden="true" class="mr-1.5 inline align-[-3px]" />{{ heading }}
      </h2>
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken"
        aria-label="Close the people list"
        data-test="roster-close"
        @click="emit('close')"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </div>

    <!-- ADR-0079: the room's NAME and its share action. The code is the
         room's identity — the data voice (JetBrains Mono), selectable so
         it can be copied by hand too; the share button goes through
         useShareRoomLink (ADR-0023), never a raw clipboard call. -->
    <div
      v-if="code"
      class="mt-3 flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 py-2.5"
    >
      <span
        class="min-w-0 select-all truncate font-mono-data text-sm font-semibold tracking-tight"
        data-test="roster-code"
        :aria-label="`Room code ${code}`"
        >{{ code }}</span
      >
      <button
        type="button"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-semibold text-on-brand transition-colors hover:bg-brand-strong active:scale-[0.98] motion-reduce:active:scale-100"
        data-test="roster-share"
        aria-label="Copy the room link"
        @click="share()"
      >
        <Share2 :size="14" aria-hidden="true" />
        Share room link
      </button>
    </div>

    <!-- The people. Rows render when a relay has TOLD us who they are; an
         absent roster is the quiet count alone, never a fake list. -->
    <ul
      v-if="members && members.length > 0"
      class="mt-3 space-y-1"
      data-test="roster-list"
    >
      <li
        v-for="(member, i) in members"
        :key="member.id ?? `guest-${i}`"
        class="flex items-center gap-3 rounded-xl px-2 py-2"
        data-test="roster-row"
      >
        <PersonAvatar :name="member.name" />
        <span class="min-w-0 flex-1 truncate text-sm font-medium" data-test="roster-name">
          {{ member.name }}
        </span>
        <span
          v-if="selfId !== null && member.id === selfId"
          class="text-xs text-text-muted"
          data-test="roster-you"
        >
          you
        </span>
      </li>
    </ul>
    <p v-else class="mt-3 text-sm text-text-muted" data-test="roster-empty">
      <template v-if="count !== null">
        {{ count === 1 ? 'Just you right now.' : `${count} connected — the room has not told this device who they are yet.` }}
      </template>
      <template v-else>Not connected to a room.</template>
    </p>
  </AppModal>
</template>
