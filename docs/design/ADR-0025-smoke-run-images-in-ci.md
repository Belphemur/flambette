# ADR-0025: Images are smoke-run in CI, not just built

**Status:** Accepted (2026-09-29).
**Extends:** ADR-0006 (room sync over a Bun relay), ADR-0007 (Bun toolchain
and base images). No runtime behaviour changes.

## Context

Issue #6: the published relay image
(`ghcr.io/belphemur/mealime-planner-relay`) crash-looped on startup with
`Cannot find module './throttle.mjs' from '/app/relay.mjs'`. The cause was
`server/Dockerfile` copying a hand-picked file list:

```dockerfile
COPY relay.mjs .
```

`server/relay.mjs` imports `./throttle.mjs`, so when the throttle module was
added (to cap create/join against blind room-code enumeration) the repo
gained the file but the image never got it. Every deployment using the
prebuilt image lost live room sync: the container never stayed up, the
`relay` DNS name did not resolve, and `/ws` returned 502.

The instructive part is why CI did not stop it. The `docker` job ran
`docker build ./server`, and that build **succeeded** — the Dockerfile is
valid, the base image is fine, one `COPY` of one existing file always
works. Nothing in the job ever *ran* the image. A build proves the image can
be assembled; it says nothing about whether the entrypoint can resolve its
imports.

## Decision

1. **Copy the runtime surface, never enumerate it.** `server/Dockerfile` uses
   `COPY *.mjs ./`. The relay is a small, flat, zero-dependency service; a glob
   keeps the image correct as modules are added and removes the failure mode
   entirely. Naming files one by one makes *adding a module* a
   publish-breaking act, which is the wrong default for a hotfix-sized service.

2. **CI must start every image it builds, not just build it.** The `docker`
   job now runs the relay image and polls its HTTP endpoint for a 200 within
   30s, dumping container logs and failing the job if the container exits
   first. A green build is not evidence of a runnable image.

3. **The gate is verified in both directions.** A smoke test that has only
   ever been seen passing proves nothing, so the gate was rehearsed locally
   against a deliberately broken image (fails, printing the module error) and
   the fixed one (passes). CI's value here is that it fails loudly and early.

## Alternatives considered

- **A test that parses the Dockerfile** and asserts each `import`ed sibling
  has a matching `COPY`. Cheaper and catches the same bug statically, but it
  re-implements Docker's glob semantics in TypeScript and still cannot prove
  the entrypoint starts. The runtime gate subsumes it.
- **`COPY . .`** with a `server/.dockerignore`. Works, but pulls
  `README.md`/`package.json` into the image and couples the build context to
  the repo layout. `*.mjs` is precise for a service whose runtime is exactly
  its `.mjs` files.
- **Healthcheck in the Dockerfile itself** (`HEALTHCHECK` instruction).
  Complementary, not a substitute: it reports a broken container to an
  orchestrator at deploy time but does not block a release. CI gating is what
  prevents publishing the broken image in the first place.

## Consequences

- Adding a relay module no longer requires touching the Dockerfile, so the
  "forgot to update the packaging" class of release bug is closed for this
  service.
- CI gains a step that talks to a network port. It is bounded (30s poll, then
  a hard failure) and cleans up the container with `if: always()`, but it is
  the first job in the repo that depends on a container actually starting.
- The relay image and the `web` image are now both built in CI; only the relay
  is smoke-run, because only it has a cheap health surface. If the `web`
  image ever gains a service that must answer on boot, the same pattern
  applies there.
