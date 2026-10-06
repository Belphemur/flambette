#!/usr/bin/env python3
"""Build the split restriction artifacts the runtime consumes ON DEMAND.

ADR-0059 split the old single `restriction_dict.json` (1,386,316 B, 96% redundant)
into a tree keyed by query-time need. The 131,920 `pairRemoved` entries carry
only 918 informative extras beyond the singles' union; the split tree ships those
918 exactly, partitioned by pair, plus swaps (~8 KB) + removed lists (~44 KB).

This script reads the SAME archive data as the old emission (the single-restriction
caches under docs-metric/<slug>/ and the archive payloads) and emits the SPLIT TREE:

    public/data/restrictions/index.json     ~2 KB   12 entries + pair file list
    public/data/restrictions/swaps.json     ~8 KB   from->to swaps + drops
    public/data/restrictions/removed/<slug>.json  ~4 KB x12   removed ids
    public/data/restrictions/pairs/<a>-<b>.json   ~1 KB x66   composition extras

Cold start fires ZERO network requests: index.json ships in the bundle (or is
read from the lib's RESTRICTIONS constant). Swaps/removed/pairs load only when
a chip activates.

    python3 scripts/build_restriction_dict.py            # build
    python3 scripts/build_restriction_dict.py --check    # verify committed tree

Shared join helpers live in build_restriction_sets.py (stdlib; runs inside
the test:data gate where uv deps are not assumed).
"""

import argparse
import json
import logging
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")
RESTRICTIONS_DIR = os.path.join(DATA, "restrictions")
INDEX_OUT = os.path.join(RESTRICTIONS_DIR, "index.json")
SWAPS_OUT = os.path.join(RESTRICTIONS_DIR, "swaps.json")

# The ADR-0057 archive built by `archive_catalog_profiles.py --restrictions`.
MEDIA = os.path.join(os.path.dirname(ROOT), "mealime-media")
ARCHIVE = os.path.join(MEDIA, "raw_profiles", "restrictions")
PAYLOAD_SUFFIX = "m6"
DOC_CACHE = os.path.join(ARCHIVE, "docs-metric")

# Shared helpers (stdlib).
sys.path.insert(0, HERE)
import build_restriction_sets as B  # noqa: E402  (doc cache, RESTRICTIONS, event extraction)
import archive_catalog_profiles as A  # noqa: E402  (RESTRICTIONS)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.info

_payload_rids_cache: dict = {}


def payload_rids(label):
    """The recipe_id set of an archived restriction payload (cached)."""
    if label in _payload_rids_cache:
        return _payload_rids_cache[label]
    path = os.path.join(ARCHIVE, label + ".json")
    with open(path) as f:
        builder = json.load(f)
    rids = frozenset(m["recipe_id"] for m in builder["variant_meta"])
    _payload_rids_cache[label] = rids
    return rids


def uuid_map(payload):
    return {m["recipe_id"]: m["published_recipe_uuid"] for m in payload["variant_meta"]}


def load_base_docs():
    docs = {}
    for path in B.doc_paths():
        with open(path) as f:
            doc = json.load(f)
        docs[doc["recipe_id"]] = doc
    return docs


def drops_for_restriction(rid, base_docs):
    """Ingredients dropped (no swap) in KEPT recipes under this restriction.

    Returns a list of {from, count} entries. `from` is the BASE CATALOG doc's
    exact spelling (catalog nameKey preserves punctuation; the folded
    name_key must NOT be used — see Bug A). A from-ingredient that swaps in
    SOME recipes and drops in others gets BOTH representations (count each
    kind); this list only carries the drops.
    """
    slug = A.RESTRICTIONS[rid][0]
    none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
    single_r = payload_rids("%s-%s" % (slug, PAYLOAD_SUFFIX))
    removed_ids = none_r - single_r

    with open(os.path.join(ARCHIVE, "%s-%s.json" % (slug, PAYLOAD_SUFFIX))) as f:
        payload = json.load(f)
    uuids = uuid_map(payload)

    drop_counter = Counter()
    for rid_in_payload in sorted(uuids):
        if rid_in_payload in removed_ids:
            continue
        if rid_in_payload not in base_docs:
            continue
        uuid = uuids[rid_in_payload]
        if not os.path.exists(os.path.join(DOC_CACHE, slug, uuid + ".json")):
            continue
        with open(os.path.join(DOC_CACHE, slug, uuid + ".json")) as f:
            rdoc = json.load(f)
        base_doc = base_docs[rid_in_payload]
        events = B.events_for_doc(base_doc, rdoc)
        for e in events:
            if e["kind"] != "removed":
                continue
            drop_counter[e["from"]] += 1

    drops = [
        {"from": f, "count": c}
        for f, c in sorted(drop_counter.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return drops


def swaps_for_restriction(rid, base_docs):
    """Extract all swap events from one restriction's restricted docs.

    Returns a list of {from, to, quantityRule, count} sorted by count desc.
    `from` and `to` use the BASE CATALOG doc's exact spelling (catalog
    nameKey preserves punctuation; the Python name_key FOLDS it, which would
    never match the runtime's nameKey — Bug A).
    """
    slug = A.RESTRICTIONS[rid][0]
    none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
    single_r = payload_rids("%s-%s" % (slug, PAYLOAD_SUFFIX))
    removed_ids = none_r - single_r

    with open(os.path.join(ARCHIVE, "%s-%s.json" % (slug, PAYLOAD_SUFFIX))) as f:
        payload = json.load(f)
    uuids = uuid_map(payload)

    from collections import defaultdict as _dd
    rule_counter = _dd(Counter)  # (from, to) -> Counter(quantityRule -> n)

    for rid_in_payload in sorted(uuids):
        if rid_in_payload in removed_ids:
            continue
        if rid_in_payload not in base_docs:
            continue
        uuid = uuids[rid_in_payload]
        if not os.path.exists(os.path.join(DOC_CACHE, slug, uuid + ".json")):
            continue
        with open(os.path.join(DOC_CACHE, slug, uuid + ".json")) as f:
            rdoc = json.load(f)
        base_doc = base_docs[rid_in_payload]
        events = B.events_for_doc(base_doc, rdoc)
        for e in events:
            if e["kind"] != "swap":
                continue
            F, T = e["from"], e["to"]
            qb = e.get("qty_base") or ""
            qn = e.get("qty_new") or ""
            rule = B.QUANTITY_RULES.get(B.qty_relation(qb, qn), "unparseable")
            rule_counter[(F, T)][rule] += 1

    swaps = []
    for (F, T), rc in rule_counter.items():
        rule_counts = rc
        dominant = rule_counts.most_common(1)[0][0]
        swaps.append({
            "from": F,
            "to": T,
            "quantityRule": dominant,
            "count": sum(rule_counts.values()),
        })
    swaps.sort(key=lambda s: (-s["count"], s["from"], s["to"]))
    return swaps


def pair_extra_removals(a, b):
    """Extra removals for a two-restriction pair (removed by pair, by neither single)."""
    none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
    a_r = payload_rids("%s-%s" % (A.RESTRICTIONS[a][0], PAYLOAD_SUFFIX))
    b_r = payload_rids("%s-%s" % (A.RESTRICTIONS[b][0], PAYLOAD_SUFFIX))
    lo, hi = min(a, b), max(a, b)
    pair_label = "combos/%d-%d-%s" % (lo, hi, PAYLOAD_SUFFIX)
    pair_r = payload_rids(pair_label)
    union = a_r | b_r
    # Extra = recipes in pair's removal set that are NOT in either single's removal set
    pair_removed = none_r - pair_r
    union_removed = none_r - union
    extras = pair_removed - union_removed
    return sorted(extras)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify the committed split tree is well-formed")
    args = ap.parse_args()

    base_docs = load_base_docs()

    if args.check:
        problems = []

        # index.json
        if not os.path.exists(INDEX_OUT):
            problems.append("index.json is missing")
        else:
            with open(INDEX_OUT) as f:
                idx = json.load(f)
            if not isinstance(idx.get("restrictions"), list) or len(idx["restrictions"]) != 12:
                problems.append("index.json: expected 12 restrictions")
            if not isinstance(idx.get("pairs"), list):
                problems.append("index.json: missing pairs list")
            for entry in idx.get("restrictions", []):
                for k in ("id", "slug", "label"):
                    if k not in entry:
                        problems.append("index.json: entry missing %s" % k)

        # swaps.json
        if not os.path.exists(SWAPS_OUT):
            problems.append("swaps.json is missing")
        else:
            with open(SWAPS_OUT) as f:
                swaps = json.load(f)
            if not isinstance(swaps.get("swaps"), list):
                problems.append("swaps.json: missing swaps list")
            if not isinstance(swaps.get("drops"), list):
                problems.append("swaps.json: missing drops list")
            for s in swaps.get("swaps", []):
                for k in ("from", "to", "quantityRule", "count"):
                    if k not in s:
                        problems.append("swaps.json: swap missing %s" % k)

        # removed/<slug>.json x12
        for rid_str in sorted(A.RESTRICTIONS, key=int):
            slug = A.RESTRICTIONS[int(rid_str)][0]
            path = os.path.join(RESTRICTIONS_DIR, "removed", slug + ".json")
            if not os.path.exists(path):
                problems.append("missing %s" % path)
                continue
            with open(path) as f:
                doc = json.load(f)
            if not isinstance(doc.get("removed"), list):
                problems.append("%s: missing removed list" % path)

        # pairs/<a>-<b>.json x66
        for a in sorted(A.RESTRICTIONS):
            for b in sorted(A.RESTRICTIONS):
                if a >= b:
                    continue
                slug_a = A.RESTRICTIONS[a][0]
                slug_b = A.RESTRICTIONS[b][0]
                path = os.path.join(RESTRICTIONS_DIR, "pairs", "%s-%s.json" % (slug_a, slug_b))
                if not os.path.exists(path):
                    problems.append("missing %s" % path)
                    continue
                with open(path) as f:
                    doc = json.load(f)
                if not isinstance(doc.get("extras"), list):
                    problems.append("%s: missing extras list" % path)

        if problems:
            for p in problems:
                log("STALE: %s" % p)
            return 1
        log("split tree well-formed")
        return 0

    # --- Build the split tree ---
    os.makedirs(RESTRICTIONS_DIR, exist_ok=True)
    os.makedirs(os.path.join(RESTRICTIONS_DIR, "removed"), exist_ok=True)
    os.makedirs(os.path.join(RESTRICTIONS_DIR, "pairs"), exist_ok=True)

    # Per-restriction data first (used by all split files).
    per_restriction = {}
    total_swaps = 0
    total_drops = 0
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        rid = int(rid_str)
        slug = A.RESTRICTIONS[rid][0]
        swaps = swaps_for_restriction(rid, base_docs)
        none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
        single_r = payload_rids("%s-%s" % (slug, PAYLOAD_SUFFIX))
        removed = sorted(none_r - single_r)
        drops = drops_for_restriction(rid, base_docs)
        per_restriction[rid_str] = {
            "removed": removed,
            "swaps": swaps,
            "drops": drops,
        }
        total_swaps += len(swaps)
        total_drops += len(drops)
        log("%s: removed=%d swaps=%d drops=%d" % (slug, len(removed), len(swaps), len(drops)))

    # 1. index.json: 12 entries + pair file list
    restrictions_meta = []
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        rid = int(rid_str)
        slug, label = A.RESTRICTIONS[rid]
        restrictions_meta.append({"id": rid, "slug": slug, "label": label})
    pair_file_list = []  # slugs like "gluten-free-dairy-free"
    for a in sorted(A.RESTRICTIONS):
        for b in sorted(A.RESTRICTIONS):
            if a >= b:
                continue
            slug_a = A.RESTRICTIONS[a][0]
            slug_b = A.RESTRICTIONS[b][0]
            pair_file_list.append("%s-%s" % (slug_a, slug_b))
    index_doc = {"restrictions": restrictions_meta, "pairs": pair_file_list}
    with open(INDEX_OUT, "w") as f:
        json.dump(index_doc, f, indent=1)
        f.write("\n")
    log("wrote %s (%d restrictions, %d pairs)" % (INDEX_OUT, len(restrictions_meta), len(pair_file_list)))

    # 2. swaps.json: per-restriction swaps (dedup across restrictions) + drops
    # PER RESTRICTION (attribution is load-bearing: the runtime hides a dropped
    # ingredient only when ITS restriction is active — a flat array would hide
    # garlic under Gluten-Free alone, because garlic is a Dairy/Soy drop).
    unique_swaps = {}
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        for s in per_restriction[rid_str]["swaps"]:
            key = (s["from"], s["to"])
            if key not in unique_swaps or s["count"] > unique_swaps[key]["count"]:
                unique_swaps[key] = s
    all_swaps = sorted(unique_swaps.values(), key=lambda s: (-s["count"], s["from"], s["to"]))
    drops_by_restriction = {}
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        drops_by_restriction[rid_str] = sorted(
            per_restriction[rid_str]["drops"], key=lambda d: (-d["count"], d["from"]))
    swaps_doc = {"swaps": all_swaps, "drops": drops_by_restriction}
    with open(SWAPS_OUT, "w") as f:
        json.dump(swaps_doc, f, indent=1)
        f.write("\n")
    log("wrote %s (%d unique swaps, drops across %d restrictions)"
        % (SWAPS_OUT, len(all_swaps), len(drops_by_restriction)))

    # 2b. events/<slug>.json — the PER-RECIPE upstream truth (owner-approved
    # option C+ design, 2026-10-08): the analysis proved upstream's swaps/drops
    # are per-recipe decisions, not global ingredient rules (drop-vs-swap
    # conflicts: 912 events across 12 restrictions; a global dictionary
    # mis-fires 525+ times under GF alone). The whole map is 116 KB raw /
    # 11 KB gzipped — smaller than the dictionary + exceptions it replaces and
    # EXACT. Structure: {<slug>: {"<recipe_id>": {"s": [[from, to]…], "d": [from…]}}}.
    events_dir = os.path.join(RESTRICTIONS_DIR, "events")
    os.makedirs(events_dir, exist_ok=True)
    total_ev = 0
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        slug = A.RESTRICTIONS[int(rid_str)][0]
        payload = json.load(open(os.path.join(ARCHIVE, "%s-%s.json" % (slug, PAYLOAD_SUFFIX))))
        uuids = {m["recipe_id"]: m["published_recipe_uuid"] for m in payload["variant_meta"]}
        none_p = json.load(open(os.path.join(ARCHIVE, "none-%s.json" % PAYLOAD_SUFFIX)))
        none_ids = {m["recipe_id"] for m in none_p["variant_meta"]}
        removed = none_ids - set(uuids)
        per_doc = {}
        for r in sorted(uuids):
            if r in removed or r not in base_docs:
                continue
            rp = os.path.join(DOC_CACHE, slug, uuids[r] + ".json")
            if not os.path.exists(rp):
                continue
            evs = B.events_for_doc(base_docs[r], json.load(open(rp)))
            doc_events = {"s": [[e["from"], e["to"], e["qty_new"]] for e in evs if e["kind"] == "swap"],
                          "d": [e["from"] for e in evs if e["kind"] == "removed"],
                          "q": [[e["from"], e["qty_new"]] for e in evs if e["kind"] == "requant"],
                          "a": [[e["to"], e["qty_new"]] for e in evs if e["kind"] == "added"]}
            if doc_events["s"] or doc_events["d"] or doc_events["q"] or doc_events["a"]:
                per_doc[str(r)] = doc_events
                total_ev += len(doc_events["s"]) + len(doc_events["d"])
        with open(os.path.join(events_dir, slug + ".json"), "w") as f:
            json.dump(per_doc, f, separators=(",", ":"))
            f.write("\n")
        log("wrote events/%s.json (%d docs, %d events)" % (slug, len(per_doc), total_ev))
    log("TOTAL upstream per-recipe events: %d" % total_ev)

    # 3. removed/<slug>.json: per-restriction removed ids
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        slug = A.RESTRICTIONS[int(rid_str)][0]
        removed_doc = {"removed": per_restriction[rid_str]["removed"]}
        with open(os.path.join(RESTRICTIONS_DIR, "removed", slug + ".json"), "w") as f:
            json.dump(removed_doc, f, indent=1)
            f.write("\n")
        log("wrote removed/%s.json (%d removed)" % (slug, len(per_restriction[rid_str]["removed"])))

    # 4. pairs/<a>-<b>.json: ONLY composition extras (extras beyond singles' union)
    # The filename uses the RUNTIME's canonical order (slug string comparison —
    # `restrictions.ts`'s pairKey). The numeric-id order used to mismatch 25 of
    # 66 files, so ensurePair 404'd silently into the empty-extras degrade.
    total_extras = 0
    for a in sorted(A.RESTRICTIONS):
        for b in sorted(A.RESTRICTIONS):
            if a >= b:
                continue
            slug_a = A.RESTRICTIONS[a][0]
            slug_b = A.RESTRICTIONS[b][0]
            first, second = sorted((slug_a, slug_b))
            extras = pair_extra_removals(a, b)
            pair_file = os.path.join(RESTRICTIONS_DIR, "pairs", "%s-%s.json" % (first, second))
            with open(pair_file, "w") as f:
                json.dump({"extras": extras}, f, indent=1)
                f.write("\n")
            total_extras += len(extras)
            log("wrote pairs/%s-%s.json (%d extras)" % (first, second, len(extras)))
    log("TOTAL pair extras across 66 pairs: %d" % total_extras)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
