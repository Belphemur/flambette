/**
 * The derived "has the user used the app" predicate (ADR-0096).
 *
 * A device is "returning" when it holds state that proves use: the plan
 * has entries, the device stands in a live room, OR a household room code
 * is saved (ADR-0019's persisted setting — the signal that covers a room
 * whose session has not resumed yet at first-navigation time). No one-time
 * "has seen the hero" flag: derived state is self-healing (a user who
 * clears everything is new again) and backup-faithful (a restored archive
 * reproduces every signal).
 *
 * The arguments are the raw signals straight from the stores:
 *  - `planCount`:       the plan entries (plan.plan.length);
 *  - `inRoom`:          whether the room store currently holds a live code;
 *  - `householdRoom`:   the persisted household code ('' when unset).
 */
export function hasUsedApp(planCount: number, inRoom: boolean, householdRoom: string): boolean {
  return planCount > 0 || inRoom || householdRoom !== ''
}
