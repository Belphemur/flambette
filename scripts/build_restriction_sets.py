#!/usr/bin/env python3
"""Build the dietary-restriction artifacts: the control plane and the overlays.

WHY THIS EXISTS
===============
Upstream Mealime's account-level `recipe_restriction_ids` do two things to a
catalog render, both measured live on 2026-10-06 (the archive built by
`archive_catalog_profiles.py --restrictions` holds the payloads):

  1. recipes containing the allergen are REMOVED outright (the restricted
     render is a strict subset — `added=0` holds for every restriction);
  2. surviving recipes keep their line-item COUNTS and quantities, but the
     ingredient NAME — and occasionally one step's prose — is swapped to a
     restriction-safe substitute, DIFFERENT per recipe (`soy sauce` becomes
     `tamari soy sauce` in one doc and `coconut aminos` in another).

That second mechanism is upstream's own re-authoring of the recipe. It cannot
be re-derived from a swap table: the choice of substitute, its spelling, and
the step prose that names it are per-recipe decisions upstream made. So the
build does NOT interpret anything at runtime — it extracts upstream's own
restricted rendering of every CHANGED doc into a committed overlay, and the
app just displays it.

Two artifacts (both committed, both offline; the app never talks to
mealime.com):

  public/data/restriction_sets.json            the control plane
  public/data/restriction_overlays/<slug>.json the reworked docs themselves

KEYING: everything joins on the STABLE `recipe_id` (ADR-0055: variant ids and
`published_recipe_uuid` are re-issued on every render; the recipe_id is the
only identity that survives a profile change). The overlay for a recipe is
keyed by the recipe_id the committed catalog already carries.

DOC SOURCING: the archived restriction payloads give each surviving recipe's
re-issued uuid. Which docs CHANGED is decided WITHOUT fetching: the payload's
`ingredient_names` (unit-free name strings, one per line item) differ from the
unrestricted baseline iff the doc was reworked. Only those docs are fetched
from the CDN (UA header, no token — the sync_catalog precedent) and cached
under ../mealime-media/raw_profiles/restrictions/docs/<slug>/; the unchanged
majority needs no fetch.

UNITS (deliberate): the archive is the account's US/6 render, so overlay
quantities are upstream's US spellings ("15 oz") carried VERBATIM. Re-
authoring them into the committed catalog's metric spelling would be exactly
the re-authoring this pipeline refuses to do. The overlay replaces the whole
`line_items`/`instructions` of a changed doc, so a restricted doc displays
upstream's own restricted rendering end to end.

KEY STABILITY (the display/key split): the overlay is DISPLAY truth only.
Every persisted or derived key (grocery line keys, checked-state keys,
measured-chip matching) is keyed by the BASE doc's nameKey. The runtime owns
that split; this build never sees app keys.

DETERMINISM: sorted keys, no floats, compact JSON. `generated_at` is derived
from the newest payload's file mtime (stable across reruns), so a rebuild
from a complete cache is byte-identical and `--check` can gate staleness.
`--check` never touches the network: it validates the committed artifacts
against the committed catalog and the goldens, and byte-compares a
cache-only rebuild when the local archive is present and complete.

    python3 scripts/build_restriction_sets.py            # build (uses network for cache misses)
    python3 scripts/build_restriction_sets.py --check    # stale-artifact gate (offline)

Stdlib only.
"""

import argparse
import json
import logging
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")
SETS_OUT = os.path.join(DATA, "restriction_sets.json")
OVERLAY_DIR = os.path.join(DATA, "restriction_overlays")

# The ADR-0055 archive built by `archive_catalog_profiles.py --restrictions`.
MEDIA = os.path.join(os.path.dirname(ROOT), "mealime-media")
ARCHIVE = os.path.join(MEDIA, "raw_profiles", "restrictions")
DOC_CACHE = os.path.join(ARCHIVE, "docs")

# The repo's committed catalog docs (base truth for keys and for the recipes
# the app can actually display).
RECIPES_DIR = os.path.join(DATA, "recipes")

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.info


class CacheMiss(Exception):
    """A restricted doc is not in the local cache (and fetching is off)."""


def doc_paths():
    """Catalog doc paths (the committed recipes, NOT the .timer.json sidecars)."""
    return [
        os.path.join(RECIPES_DIR, n)
        for n in sorted(os.listdir(RECIPES_DIR))
        if n.endswith(".json") and not n.endswith(".timer.json")
    ]


def load_payloads():
    """(payloads by slug, index) or (None, None) when incomplete."""
    from archive_catalog_profiles import RESTRICTIONS

    index_path = os.path.join(ARCHIVE, "index.json")
    if not os.path.exists(index_path):
        return None, None
    with open(index_path) as f:
        index = json.load(f)
    payloads = {}
    for rid, (slug, _label) in RESTRICTIONS.items():
        path = os.path.join(ARCHIVE, slug + "-us6.json")
        if not os.path.exists(path):
            return None, index
        with open(path) as f:
            payloads[slug] = json.load(f)
    none_path = os.path.join(ARCHIVE, "none-us6.json")
    if not os.path.exists(none_path):
        return None, index
    with open(none_path) as f:
        payloads["none"] = json.load(f)
    return payloads, index


def name_signature(meta):
    """The unit-free name list used to decide whether a doc was reworked."""
    return list(meta.get("ingredient_names") or [])


def fetch_doc_cached(slug, uuid, fetch=True):
    """The restricted doc's parsed JSON, from the cache or the CDN."""
    path = os.path.join(DOC_CACHE, slug, uuid + ".json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    if not fetch:
        raise CacheMiss("%s/%s" % (slug, uuid))
    from archive_catalog_profiles import fetch_doc

    blob = fetch_doc(uuid)
    os.makedirs(os.path.join(DOC_CACHE, slug), exist_ok=True)
    with open(path, "wb") as f:
        f.write(blob)
    return json.loads(blob.decode())


def plan_build(fetch=True):
    """Everything needed to emit the artifacts.

    Returns (sets_obj, overlays {slug: overlay_obj}, stats) or None (with the
    reason logged). With fetch=False a doc-cache miss aborts with CacheMiss —
    --check uses that to stay offline.
    """
    from archive_catalog_profiles import RESTRICTIONS

    payloads, _index = load_payloads()
    if payloads is None:
        log("ERROR: restriction archive incomplete under %s (run the archiver)" % ARCHIVE)
        return None

    none_meta = {m["recipe_id"]: m for m in payloads["none"]["variant_meta"]}

    # The repo catalog: recipe_id -> committed base doc. The app can only
    # display these; a payload recipe absent here is invisible anyway.
    base_docs = {}
    for path in doc_paths():
        with open(path) as f:
            doc = json.load(f)
        base_docs[doc["recipe_id"]] = doc

    sets_restrictions = {}
    overlays = {}
    stats = []
    for rid, (slug, label) in sorted(RESTRICTIONS.items()):
        meta_by_recipe = {m["recipe_id"]: m for m in payloads[slug]["variant_meta"]}
        removed = sorted(set(none_meta) - set(meta_by_recipe))
        added = sorted(set(meta_by_recipe) - set(none_meta))
        if added:
            log("ERROR: %s: restricted render is NOT a subset (added=%d: %s...)"
                % (slug, len(added), added[:5]))
            log("       the payload raced the async set_profile — re-run the archiver")
            return None

        changed = sorted(
            r for r, m in meta_by_recipe.items()
            if r in none_meta and name_signature(m) != name_signature(none_meta[r])
        )
        # Only docs the app can display are carried.
        displayable = [r for r in changed if r in base_docs]
        dropped_not_in_catalog = len(changed) - len(displayable)

        docs = {}
        for r in displayable:
            uuid = meta_by_recipe[r]["published_recipe_uuid"]
            try:
                rdoc = fetch_doc_cached(slug, uuid, fetch=fetch)
            except CacheMiss:
                raise
            except Exception as e:  # noqa: BLE001 - report and fail the build
                log("ERROR: %s: doc fetch failed for recipe_id %s: %s" % (slug, r, e))
                return None
            if rdoc.get("recipe_id") != r:
                log("ERROR: %s: doc %s belongs to recipe_id %s, expected %s"
                    % (slug, uuid, rdoc.get("recipe_id"), r))
                return None
            rli = rdoc.get("line_items", [])
            # Line-item counts are stable across unit renders (measured
            # 2759/2759 on the us-6 archive) but a restriction REWORK moves
            # them freely: a protein substituted away vanishes, two swapped
            # lines can merge into one (GF recipe_id 863: shrimp -> eggs,
            # fish sauce + soy sauce -> one 'tamari soy sauce'), and one line
            # can split into two (GF recipe_id 1292: flour tortilla ->
            # avocados + butter lettuce). Upstream's re-authoring is the
            # truth we publish, so there is NO count rule against the base
            # doc — only the payload census, as a drift warning.
            census = len(meta_by_recipe[r].get("ingredient_names") or [])
            if len(rli) != census:
                log("WARNING: %s: recipe_id %s doc has %d line items, payload census %d"
                    % (slug, r, len(rli), census))
            docs[str(r)] = {
                "line_items": [
                    {"quantity": li.get("quantity"), "ingredient_name": li.get("ingredient_name")}
                    for li in rli
                ],
                "instructions": rdoc.get("instructions", []),
            }
        overlays[slug] = {"slug": slug, "docs": docs}
        sets_restrictions[str(rid)] = {
            "slug": slug,
            "label": label,
            "removed": removed,
            "overlay": "restriction_overlays/%s.json" % slug,
            "swapped_docs": len(docs),
        }
        stats.append((slug, label, len(removed), len(docs), dropped_not_in_catalog))

    newest = max(
        os.path.getmtime(os.path.join(ARCHIVE, slug + "-us6.json"))
        for (slug, _l) in RESTRICTIONS.values()
    )
    sets_obj = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(newest)),
        "restrictions": sets_restrictions,
    }
    return sets_obj, overlays, stats


def emit(sets_obj, overlays):
    os.makedirs(OVERLAY_DIR, exist_ok=True)
    with open(SETS_OUT, "w") as f:
        json.dump(sets_obj, f, indent=1, sort_keys=True)
        f.write("\n")
    for slug, obj in sorted(overlays.items()):
        path = os.path.join(OVERLAY_DIR, slug + ".json")
        with open(path, "w") as f:
            json.dump(obj, f, sort_keys=True, separators=(",", ":"))
            f.write("\n")


def check():
    """The stale-artifact gate. Offline always.

    Tier A (no archive needed): the committed artifacts are internally
    consistent, agree with the committed catalog, and hold the goldens.
    Tier B (archive complete and doc cache complete): a cache-only rebuild
    is byte-identical to what is committed.
    """
    problems = []
    if not os.path.exists(SETS_OUT):
        return ["%s is missing" % SETS_OUT]
    with open(SETS_OUT) as f:
        committed_sets = json.load(f)

    base_docs = {}
    for path in doc_paths():
        with open(path) as f:
            doc = json.load(f)
        base_docs[doc["recipe_id"]] = doc

    from archive_catalog_profiles import RESTRICTIONS

    got = committed_sets.get("restrictions", {})
    if sorted(got) != sorted(str(r) for r in RESTRICTIONS):
        problems.append("restriction ids %s != expected %s"
                        % (sorted(got), sorted(str(r) for r in RESTRICTIONS)))
    for rid, info in sorted(got.items()):
        slug = info.get("slug")
        label = info.get("label")
        if slug not in [s for s, _ in RESTRICTIONS.values()]:
            problems.append("%s: unknown slug %s" % (rid, slug))
            continue
        if RESTRICTIONS[int(rid)][1] != label:
            problems.append("%s: label %r != %r" % (rid, label, RESTRICTIONS[int(rid)][1]))
        removed = info.get("removed")
        if not isinstance(removed, list) or removed != sorted(set(removed)) \
                or not all(isinstance(r, int) for r in removed):
            problems.append("%s: removed not a sorted int list" % rid)
        want_overlay = "restriction_overlays/%s.json" % slug
        if info.get("overlay") != want_overlay:
            problems.append("%s: overlay path %r != %r" % (rid, info.get("overlay"), want_overlay))
        opath = os.path.join(DATA, want_overlay)
        if not os.path.exists(opath):
            problems.append("missing overlay %s" % want_overlay)
            continue
        with open(opath) as f:
            overlay = json.load(f)
        if overlay.get("slug") != slug:
            problems.append("%s: overlay slug mismatch" % slug)
        docs = overlay.get("docs", {})
        if info.get("swapped_docs") != len(docs):
            problems.append("%s: swapped_docs %s != %d overlay docs"
                            % (rid, info.get("swapped_docs"), len(docs)))
        for r, doc in sorted(docs.items(), key=lambda kv: int(kv[0])):
            if int(r) not in base_docs:
                problems.append("%s overlay doc %s has no committed catalog doc" % (slug, r))
                continue
            if not doc.get("line_items") or "instructions" not in doc:
                problems.append("%s overlay doc %s missing line_items/instructions" % (slug, r))

    # The goldens the brief pins.
    gf = got.get("1")
    if gf:
        if 50 not in gf["removed"]:
            problems.append("GF golden: rid 50 must be in removed")
        if 2195 in gf["removed"]:
            problems.append("GF golden: rid 2195 must NOT be in removed")
        with open(os.path.join(DATA, gf["overlay"])) as f:
            gf_overlay = json.load(f)
        doc = gf_overlay["docs"].get("2195")
        if doc is None:
            problems.append("GF golden: overlay must carry rid 2195")
        else:
            rotini = [li for li in doc["line_items"] if "rotini" in li["ingredient_name"]]
            if not rotini or rotini[0]["ingredient_name"] != "gluten-free rotini pasta" \
                    or rotini[0]["quantity"] != "15 oz":
                problems.append("GF golden: rid 2195 rotini swap wrong: %s" % rotini)

    # Tier B: byte-identical cache-only rebuild.
    try:
        planned = plan_build(fetch=False)
    except CacheMiss as e:
        log("NOTE: doc cache incomplete (%s); freshness compared against the committed "
            "catalog only" % e)
        planned = None
    if planned is not None:
        sets_obj, overlays, _stats = planned
        with open(SETS_OUT) as f:
            if json.load(f) != sets_obj:
                problems.append("restriction_sets.json differs from a cache-only rebuild")
        for slug, obj in sorted(overlays.items()):
            path = os.path.join(OVERLAY_DIR, slug + ".json")
            with open(path) as f:
                if json.load(f) != obj:
                    problems.append("overlay %s.json differs from a cache-only rebuild" % slug)
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify the committed artifacts are fresh (offline)")
    args = ap.parse_args()

    if args.check:
        problems = check()
        for p in problems:
            log("STALE: %s" % p)
        if not problems:
            log("restriction artifacts fresh")
        return 1 if problems else 0

    try:
        planned = plan_build()
    except CacheMiss as e:
        log("ERROR: unexpected cache miss: %s" % e)
        return 1
    if planned is None:
        return 1
    sets_obj, overlays, stats = planned
    emit(sets_obj, overlays)
    total = 0
    for slug, label, removed, docs, dropped in stats:
        size = os.path.getsize(os.path.join(OVERLAY_DIR, slug + ".json"))
        total += docs
        log("%-16s %-14s removed=%4d swapped=%4d (not in catalog: %d)  %.0f KiB"
            % (slug, label, removed, docs, dropped, size / 1024))
    log("committed %s and %d overlays (%d reworked docs)" % (SETS_OUT, len(overlays), total))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
