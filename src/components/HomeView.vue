<script setup lang="ts">
/**
 * The home hero (ADR-0078). `/` is a statement of what the app is — no
 * account, household planning over a three-word code, 2,500+ hand-curated
 * recipes — designed on the Warm Culinary Paper tokens (Stitch screen
 * "Flambette — Home Page Hero"). The hero route has NO bottom nav (the
 * app header stays, Q2); it keeps the app-shell default head (canonical
 * `/`), and it is deliberately NOT in the KeepAlive include list — the
 * hero is stateless and cheap to re-render.
 *
 * Placeholder build (routes commit): the full composition lands with the
 * hero + household-modal commit.
 */
</script>

<template>
  <section data-test="home-hero" class="px-4 pt-4 pb-20">Home</section>
</template>