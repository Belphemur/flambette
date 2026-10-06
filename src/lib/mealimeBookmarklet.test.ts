import { describe, expect, test } from 'bun:test'
import { MEALIME_BOOKMARKLET_SOURCE, mealimeBookmarkletHref } from './mealimeBookmarklet'

describe('mealime bookmarklet (ADR-0058)', () => {
  test('reads the auth_token cookie by name', () => {
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('auth_token')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('document.cookie')
  })

  test('calls the get_builder_data endpoint with the my-web source', () => {
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('api.mealime.com/api/v2/get_builder_data')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('source:"my-web"')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('f4590t00mx4')
  })

  test('derives recipe_id from the thumbnail folder and copies a bookmarklet payload', () => {
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('/uploads\\/recipe\\/thumbnail\\/')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('flambette-bookmarklet')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('navigator.clipboard.writeText')
  })

  test('fails loudly on every terminal path (never silently)', () => {
    const alerts = MEALIME_BOOKMARKLET_SOURCE.match(/alert\(/g) ?? []
    // not-logged-in, zero favourites, clipboard failure, request failure,
    // success summary. (A non-OK response throws into the catch alert.)
    expect(alerts.length).toBe(5)
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('no favourites found')
    expect(MEALIME_BOOKMARKLET_SOURCE).toContain('Copied')
  })

  test('holds no token or cookie VALUE — only the cookie name', () => {
    expect(MEALIME_BOOKMARKLET_SOURCE).not.toMatch(/_BB8sG3/)
    expect(MEALIME_BOOKMARKLET_SOURCE).not.toMatch(/auth_token=[A-Za-z0-9_\-]{10,}/)
  })

  test('the href is the URL-encoded source behind javascript:', () => {
    const href = mealimeBookmarkletHref()
    // Parse, don't string-match the scheme (CodeQL js/incomplete-url-scheme-check).
    const url = new URL(href)
    expect(url.protocol).toBe('javascript:')
    expect(decodeURIComponent(url.pathname)).toBe(MEALIME_BOOKMARKLET_SOURCE)
  })
})
