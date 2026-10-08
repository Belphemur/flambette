/**
 * The avatar generator's palette bridge (ADR-0063).
 *
 * A person avatar is IDENTITY ART (DESIGN.md): its palette is produced by
 * the `hashvatar` generator and is exempt from the token audit the way
 * recipe photography is — but it is still BOUNDED by the design system:
 * the `tones` passed to `createHashvatar` are read AT RUNTIME from the
 * existing family tokens (`--color-hue-*`, `--color-meal-*`,
 * `--color-nutrition-*`), so an avatar never invents a colour the system
 * does not carry, no hex literal reaches `src/`, and a palette change (or
 * the `.dark` flip, which re-points the same custom properties) re-skins
 * every avatar for free.
 *
 * The extraction is a pure function over a computed style, so the unit
 * tests can stub the style object and pin the contract without a browser.
 */

/**
 * The custom-property families avatars draw from, in a FIXED order so the
 * tone list is deterministic for a given palette regardless of how the
 * browser enumerates declarations. Token NAMES here, never hex values —
 * spelling a token name is exactly what every component already does with
 * its Tailwind classes.
 */
export const AVATAR_TONE_PREFIXES: readonly string[] = [
  '--color-hue-',
  '--color-meal-',
  '--color-nutrition-',
]

/** The slice of `CSSStyleDeclaration` the extractor needs. */
export interface ComputedStyleLike {
  getPropertyValue(name: string): string
  [Symbol.iterator](): IterableIterator<string>
}

/**
 * Collect the tone values declared under the avatar families, deduped by
 * VALUE (several tokens share a colour across families) and in declaration
 * order. Empty values are skipped — an unset token is not a tone.
 */
export function extractAvatarTones(style: ComputedStyleLike): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const prop of style) {
    if (typeof prop !== 'string') continue
    if (!AVATAR_TONE_PREFIXES.some((prefix) => prop.startsWith(prefix))) continue
    const value = style.getPropertyValue(prop).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * The tones for THIS theme, read from the root element's computed style.
 * Empty when there is no DOM (unit tests, prerender) — the caller passes
 * no `tones` at all and the generator falls back to its own palette
 * rather than an empty one.
 */
export function avatarTones(): string[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return []
  return extractAvatarTones(window.getComputedStyle(document.documentElement))
}
