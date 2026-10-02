# Relay service: zero-dependency Bun WebSocket relay, no build step.
FROM oven/bun:1-alpine
WORKDIR /app/server
# The build context is the REPO ROOT (ci.yml, release.yml and docker-compose.yml
# all pass `-f server/Dockerfile` from there), because relay-core/codes.ts
# re-exports src/lib/roomWords.ts — the single src/ import ADR-0040 allows, so
# the canonicaliser cannot be forked. A `./server` context cannot reach it, and
# the image crash-looped on `Cannot find module '../../src/lib/roomWords'`.
#
# Copy the WHOLE runtime surface, not a hand-picked list. relay.ts imports
# ./relay-core/*, and a missing sibling module is a startup crash-loop that
# `docker build` alone never catches — naming files one by one meant adding
# a module silently broke the published image (issue #6). Keep the globs.
#
# The tree layout is preserved on purpose: relay-core/codes.ts reaches its
# sibling src/ dependency by RELATIVE path (`../../src/lib/roomWords`), so
# flattening server/ to the image root would point that import at `/src`.
COPY server/*.ts ./
COPY server/relay-core/ ./relay-core/
# The one cross-tree dependency, named on purpose: it lives outside server/,
# so the globs above cannot cover it.
COPY src/lib/roomWords.ts /app/src/lib/roomWords.ts
EXPOSE 8081
CMD ["bun", "relay.ts"]
