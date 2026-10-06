#!/usr/bin/env python3
"""Build the ingredient substitution dictionary the runtime consumes.

WHY THIS EXISTS
===============
The runtime does NOT compose or hardcode substitutions — it reads a small
DATA DICTIONARY derived by the Python pipeline from upstream's own restricted
renders. Per restriction id the dictionary carries:

  * removed — the recipes upstream drops for that restriction
  * pairRemoved — per two-restriction pair, the EXTRA recipes the pair removes
    that NEITHER single removes (the composition effects measured in TASK 2)
  * swaps — per (from -> to) ingredient pair, the quantity rule upstream applied
    and how many events back it

Swaps are derived from the restricted DOCS in the build cache (not from the
payload census, which has no quantities), so the quantityRule reflects the
real re-authoring: 99.8% of upstream swaps keep the base quantity string
verbatim, 0.1% rescale (same unit, doubled), 0.1% re-author.

The 66 combo payloads are the ANALYSIS INPUT (gitignored, outside the repo).
This script reads the SINGLE-restriction caches under docs-metric/<slug>/ —
the same caches `build_restriction_sets.py` populates — and the archive
payloads for removal sets. It is stdlib-only.

    python3 scripts/build_restriction_dict.py            # build

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
DICT_OUT = os.path.join(DATA, "restriction_dict.json")

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


def swaps_for_restriction(rid, base_docs):
    """Extract all swap events from one restriction's restricted docs.

    Returns a list of {from, to, quantityRule, count} sorted by count desc.
    """
    slug = A.RESTRICTIONS[rid][0]
    none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
    single_r = payload_rids("%s-%s" % (slug, PAYLOAD_SUFFIX))
    removed_ids = none_r - single_r

    with open(os.path.join(ARCHIVE, "%s-%s.json" % (slug, PAYLOAD_SUFFIX))) as f:
        payload = json.load(f)
    uuids = uuid_map(payload)

    from collections import defaultdict as _dd
    rule_counter = _dd(Counter)  # (from_key, to_key) -> Counter(quantityRule -> n)

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
            F, T = e["from_key"], e["to_key"]
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
    ap.add_argument("--check", action="store_true", help="verify the committed dict is well-formed")
    args = ap.parse_args()

    base_docs = load_base_docs()

    if args.check:
        if not os.path.exists(DICT_OUT):
            log("ERROR: %s is missing" % DICT_OUT)
            return 1
        with open(DICT_OUT) as f:
            d = json.load(f)
        problems = []
        for rid_str, info in d.items():
            if not isinstance(info.get("removed"), list):
                problems.append("%s: missing removed list" % rid_str)
            if not isinstance(info.get("swaps"), list):
                problems.append("%s: missing swaps list" % rid_str)
            if not isinstance(info.get("pairRemoved"), dict):
                problems.append("%s: missing pairRemoved dict" % rid_str)
            for s in info.get("swaps", []):
                for k in ("from", "to", "quantityRule", "count"):
                    if k not in s:
                        problems.append("%s: swap missing %s" % (rid_str, k))
        if problems:
            for p in problems:
                log("STALE: %s" % p)
            return 1
        log("restriction_dict.json well-formed")
        return 0

    result = {}
    total_swaps = 0
    total_pairs = 0
    for rid_str in sorted(A.RESTRICTIONS, key=int):
        rid = int(rid_str)
        slug = A.RESTRICTIONS[rid][0]
        swaps = swaps_for_restriction(rid, base_docs)
        pair_removed = {}
        for a in sorted(A.RESTRICTIONS):
            if a == rid:
                continue
            pair_key = "%d,%d" % (min(rid, a), max(rid, a))
            extras = pair_extra_removals(rid, a)
            if extras:
                pair_removed[pair_key] = extras
                total_pairs += 1
        none_r = payload_rids("none-%s" % PAYLOAD_SUFFIX)
        single_r = payload_rids("%s-%s" % (slug, PAYLOAD_SUFFIX))
        removed = sorted(none_r - single_r)
        result[rid_str] = {
            "removed": removed,
            "pairRemoved": pair_removed,
            "swaps": swaps,
        }
        total_swaps += len(swaps)
        log("%s: removed=%d swaps=%d pairs_with_extras=%d"
            % (slug, len(removed), len(swaps), len(pair_removed)))

    os.makedirs(DATA, exist_ok=True)
    with open(DICT_OUT, "w") as f:
        json.dump(result, f, indent=1, sort_keys=True)
        f.write("\n")
    log("wrote %s (%d restrictions, %d swap entries, %d pair entries)"
        % (DICT_OUT, len(result), total_swaps, total_pairs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
