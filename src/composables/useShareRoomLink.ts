/**
 * One-tap "Share room" (ADR-0023).
 *
 * The only job of this action is to put `<origin>/plan?room=<code>` on
 * the clipboard, in ONE tap, with no picker and no `navigator.share`
 * (plain-HTTP LAN origins have no Web Share — AGENTS.md pitfall). The
 * clipboard goes through `useClipboard({ legacy: true })`, the same
 * sanctioned path the Plan tab's share link uses.
 *
 * It never fails silently: when the clipboard cannot be written the
 * toast carries the link itself so the user can still copy it by hand.
 */

import { useClipboard } from '@vueuse/core'
import { normalizeRoomCode } from '../lib/roomWords'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'
import type { ToastAction } from '../stores/ui'

export function useShareRoomLink() {
  const room = useRoomStore()
  const ui = useUiStore()
  const { copy, copied } = useClipboard({ legacy: true })

  /** The code to share: explicit → the live room → the saved setting. */
  function shareableCode(code?: string | null): string {
    return normalizeRoomCode(code ?? room.code ?? ui.householdRoom)
  }

  /**
   * Copy the join link for `code` (defaults to the live/saved room).
   * Returns true when the clipboard took it.
   */
  async function shareRoomLink(code?: string | null): Promise<boolean> {
    const target = shareableCode(code)
    if (!target) {
      ui.showToast('No room to share yet — set a room code first', { kind: 'error' })
      return false
    }
    const link = room.roomLinkFor(target)
    let written = false
    try {
      await copy(link)
      written = copied.value
    } catch {
      written = false
    }
    // `useClipboard` sets `copied` even when the legacy execCommand write
    // silently failed, so verify by reading back where the origin allows
    // it. An unreadable clipboard is NOT treated as a failure.
    if (written) {
      try {
        const read = await navigator.clipboard?.readText?.()
        if (typeof read === 'string' && read !== link) written = false
      } catch {
        /* read-back unavailable — keep the write's own verdict */
      }
    }
    if (!written) {
      // Never a silent failure: show the link so it can be copied by hand.
      ui.showToast(`Couldn't copy automatically — the link is ${link}`, { duration: 8000 })
      return false
    }
    ui.showToast('Copied! Anyone with this link joins your household.', { kind: 'share-room' })
    return true
  }

  /** A toast action button that shares `code` (used on join toasts). */
  function shareAction(code?: string | null): ToastAction {
    return { label: 'Share link', run: () => void shareRoomLink(code) }
  }

  return { shareRoomLink, shareAction, shareableCode }
}
