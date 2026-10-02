# ADR-0001: Fully offline frozen recipe catalog

- **Status:** accepted
- **Date:** 2026-09-20
- **Decides:** where recipe data comes from at runtime

## Context

The Mealime scraping endpoints (including the CDN recipe docs) require
an authenticated token, and the service may change or die at any time.
Serving the SPA from that API live would make the app break the day
the token or API changes, and would leak the owner's token into every
visitor's browser.

## Decision

The full catalog (2,759 recipe variant docs + images) is scraped once
and committed into the repo (`public/data/`, `public/img/recipes/`).
The SPA makes **zero runtime requests to any `mealime.com` host**.
This is enforced in e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`) — any test that touches the catalog runs
with request blocking on, so a new fetch to Mealime fails CI, not the
app in production.

## Consequences

- Repo carries ~180 MB of webp images and ~16 MB of JSON — accepted;
  it IS the product.
- Images ship as webp derivatives; orig archives live outside the repo.
- No token ever ships to browsers. Any new data flow must not add
  runtime fetches to external hosts.

## Alternatives considered

- **Live API proxy through a backend** — rejected: needs a server to
  stay up, leaks the token's scope, contradicts the SPA-on-static-hosting
  goal.
- **Fetch-on-first-run into IndexedDB** — rejected: worse first-run UX,
  still needs the token somewhere.
