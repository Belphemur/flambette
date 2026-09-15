/**
 * Offline image resolution.
 *
 * Mealime's CDN (cdn-uploads.mealime.com) is shutting down, so every recipe
 * image has been archived into `public/img/recipes/`. The mapping is
 * mechanical: take the basename of the remote URL and swap the extension for
 * `.webp`, e.g.
 *
 *   https://cdn-uploads.mealime.com/uploads/recipe/thumbnail/121/thumbnail_66b04870-….jpg
 *   → {BASE_URL}img/recipes/thumbnail_66b04870-….webp
 */

/** Tiny neutral placeholder (1x1 stone-grey pixel) for recipes without an image. */
const PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#e7e5e4"/></svg>',
  )

/** Map a remote Mealime image URL to its local offline path, or null. */
export function localImageUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null
  const basename = remoteUrl.split('/').pop() ?? ''
  if (!basename) return null
  const dot = basename.lastIndexOf('.')
  const stem = dot > 0 ? basename.slice(0, dot) : basename
  return `${import.meta.env.BASE_URL}img/recipes/${stem}.webp`
}

/** Like {@link localImageUrl} but falls back to a neutral placeholder. */
export function imageSrc(remoteUrl: string | null | undefined): string {
  return localImageUrl(remoteUrl) ?? PLACEHOLDER
}

/**
 * `@error` handler for `<img>`: swap a broken/missing local image for the
 * neutral placeholder (guarded so a failing placeholder can't loop).
 */
export function onImgError(e: Event): void {
  const img = e.target as HTMLImageElement | null
  if (!img || img.dataset.imgFallback) return
  img.dataset.imgFallback = '1'
  img.src = PLACEHOLDER
}
