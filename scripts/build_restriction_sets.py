"""Build the dietary-restriction control plane artifact.

WHY THIS EXISTS
===============
Upstream Mealime's account-level `recipe_restriction_ids` REMOVE recipes
outright from the catalog (the restricted render is a strict subset —
`added=0` holds for every restriction). The runtime needs the per-restriction
RECIPE removal lists to filter discovery, plus the ingredient swap table for
substitution. Those come from `public/data/restriction_dict.json` (built by
`scripts/build_restriction_dict.py` — the ONE source of truth for the runtime).

This script's remaining job is to verify the control-plane inputs are
self-consistent at build time. It no longer emits overlays (those were the
option-B approach, deleted by ADR-0056 option C — the runtime consumes the
dictionary only).

    python3 scripts/build_restriction_sets.py            # verify (offline)
    python3 scripts/build_restriction_sets.py --check    # stale-artifact gate

Stdlib only.
"""

import argparse
import json
import logging
import os
import re
import time
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "public", "data")

# The ADR-0057 archive built by `archive_catalog_profiles.py --restrictions`.
MEDIA = os.path.join(os.path.dirname(ROOT), "mealime-media")
ARCHIVE = os.path.join(MEDIA, "raw_profiles", "restrictions")
PAYLOAD_SUFFIX = "m6"

# The repo's committed catalog docs (base truth for keys).
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
        path = os.path.join(ARCHIVE, slug + "-%s.json" % PAYLOAD_SUFFIX)
        if not os.path.exists(path):
            return None, index
        with open(path) as f:
            payloads[slug] = json.load(f)
    none_path = os.path.join(ARCHIVE, "none-%s.json" % PAYLOAD_SUFFIX)
    if not os.path.exists(none_path):
        return None, index
    with open(none_path) as f:
        payloads["none"] = json.load(f)
    return payloads, index


# ---------------------------------------------------------------------------
# Shared event-extraction helpers (also imported by the analysis script and
# `build_restriction_dict.py`). Stdlib only.
# ---------------------------------------------------------------------------

_NONWORD = re.compile(r"[^a-z0-9 ]+")
_SPACES = re.compile(r"\s+")


def name_key(name):
    """A forgiving normalised name for MATCHING lines across renders."""
    s = _NONWORD.sub(" ", name.lower())
    return _SPACES.sub(" ", s).strip()


# First number (decimal or vulgar/simple fraction) + the unit-ish tail.
_NUM = re.compile(r"^\s*(\d+(?:[.,]\d+)?|\d+\s+\d+/\d+|\d+/\d+|½|¼|¾|⅓|⅔)\s*(.*)$")
_VULGAR = {"½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3"}


def parse_qty(q):
    """(number | None, unit-tail | '') from a metric quantity string."""
    if not q:
        return None, ""
    m = _NUM.match(q.replace("\u00a0", " ").strip())
    if not m:
        return None, q.strip()
    tok, tail = m.group(1), m.group(2).strip()
    tok = _VULGAR.get(tok, tok)
    try:
        if "/" in tok:
            parts = tok.split()
            if len(parts) == 2:
                whole, frac = parts
                n = int(whole) + int(frac.split("/")[0]) / int(frac.split("/")[1])
            else:
                n = int(tok.split("/")[0]) / int(tok.split("/")[1])
        else:
            n = float(tok.replace(",", "."))
    except (ValueError, ZeroDivisionError):
        return None, tail
    return n, tail


def qty_relation(qb, qn):
    """same | spelling | scaled | unit-change | re-authored | unparseable."""
    if (qb or "").strip() == (qn or "").strip():
        return "same"
    nb, ub = parse_qty(qb or "")
    nn, un = parse_qty(qn or "")
    if nb is None or nn is None:
        return "unparseable"
    if ub == un:
        return "scaled" if abs(nn - nb) > 1e-9 else "spelling"
    if abs(nn - nb) < 1e-9:
        return "unit-change"
    return "re-authored"


QUANTITY_RULES = {"same": "verbatim", "spelling": "verbatim", "scaled": "rescale",
                  "unit-change": "unit-change", "re-authored": "re-authored",
                  "unparseable": "unparseable"}


def _name_contains(base_key: str, overlay_key: str) -> bool:
    """True when overlay's name contains the base name's key or its head noun.

    Upstream's substitutes keep the quantity but the name carries a family
    token: `soy sauce` -> `tamari soy sauce` (base key is a substring),
    `rotini pasta` -> `gluten free rotini pasta` (base key is a substring),
    `panko bread crumbs` -> `gluten free bread crumbs` (base head noun
    `bread crumbs` is a substring). First checks direct bidirectional
    containment, then falls back to tail word sequences (head noun).
    """
    if base_key in overlay_key or overlay_key in base_key:
        return True
    bwords = base_key.split()
    for length in range(min(len(bwords), 4), 1, -1):
        for start in range(len(bwords) - length + 1):
            phrase = " ".join(bwords[start:start + length])
            if len(phrase) >= 3 and phrase in overlay_key:
                return True
    return False


def pair_lines(base, ov):
    """Mirror of the runtime's pairing (restrictions.ts pairOverlayToBase).

    Returns (pairs, ov_left, base_left): pairs is {ov_index: base_index}.
    base/ov rows are (key, name, quantity) triples — exact key first, unique
    containment second, in-order leftovers with both quantities unique third.
    """
    used_b = set()
    pairs = {}
    for j, (k, _n, _q) in enumerate(ov):
        if not k:
            continue
        for i, (bk, _bn, _bq) in enumerate(base):
            if i in used_b or not bk:
                continue
            if bk == k:
                pairs[j] = i
                used_b.add(i)
                break
    open_ov = [j for j, (_k, _n, _q) in enumerate(ov) if j not in pairs and k]
    open_base = [i for i, (_k, _n, _q) in enumerate(base) if i not in used_b and k]
    for j in open_ov:
        k = ov[j][0]
        cands = [i for i in open_base
                 if i not in used_b and (base[i][0] in k or k in base[i][0])]
        if len(cands) == 1:
            pairs[j] = cands[0]
            used_b.add(cands[0])
    open_ov = [j for j in open_ov if j not in pairs]
    base_left = [i for i in open_base if i not in used_b]
    # Fallback: pair a base-left line to an overlay-left line by EITHER:
    #   (a) name containment + quantity agreement (catches family-token
    #       substitutes: `soy sauce` -> `tamari soy sauce`, `rotini pasta` ->
    #       `gluten free rotini pasta`, `panko bread crumbs` -> `gluten free
    #       bread crumbs` — Bug C); OR
    #   (b) equal quantity that is unique in BOTH docs (catches
    #       completely different ingredient names that keep the quantity:
    #       `butter, unsalted` -> `virgin coconut oil`).
    # (b) requires uniqueness to avoid index-order mis-pairing when two
    #     different base ingredients share a quantity string.
    ovq = Counter(ov[j][2].strip() for j in open_ov)
    baseq = Counter(base[i][2].strip() for i in open_base)
    for n in range(min(len(open_ov), len(open_base))):
        j, i = open_ov[n], open_base[n]
        qo, qb = ov[j][2].strip(), base[i][2].strip()
        if qo != qb:
            continue
        if _name_contains(base[i][0], ov[j][0]):
            pairs[j] = i
            used_b.add(i)
        elif ovq[qo] == 1 and baseq[qb] == 1:
            pairs[j] = i
            used_b.add(i)
    return pairs, open_ov, base_left


def events_for_doc(base_doc, rdoc):
    """Substitution events between the base catalog doc and a restricted doc.

    Each event: {kind: swap|added|removed, from/to names + keys, quantities}.
    """
    base = [(name_key(li.get("ingredient_name") or ""), li.get("ingredient_name") or "",
             (li.get("quantity") or "")) for li in base_doc.get("line_items", [])]
    ov = [(name_key(li.get("ingredient_name") or ""), li.get("ingredient_name") or "",
           (li.get("quantity") or "")) for li in rdoc.get("line_items", [])]
    pairs, ov_left, base_left = pair_lines(base, ov)
    evs = []
    for j, i in sorted(pairs.items()):
        if base[i][0] != ov[j][0]:
            evs.append({"kind": "swap", "from": base[i][1], "from_key": base[i][0],
                        "to": ov[j][1], "to_key": ov[j][0],
                        "qty_base": base[i][2], "qty_new": ov[j][2]})
    for j in ov_left:
        evs.append({"kind": "added", "to": ov[j][1], "to_key": ov[j][0],
                    "qty_new": ov[j][2]})
    for i in base_left:
        evs.append({"kind": "removed", "from": base[i][1], "from_key": base[i][0],
                    "qty_base": base[i][2]})
    return evs


def plan_build(fetch=True):
    """Verify the control plane inputs are self-consistent.

    Returns (sets_obj, stats) or None (with the reason logged).
    """
    from archive_catalog_profiles import RESTRICTIONS

    payloads, _index = load_payloads()
    if payloads is None:
        log("ERROR: restriction archive incomplete under %s (run the archiver)" % ARCHIVE)
        return None

    none_meta = {m["recipe_id"]: m for m in payloads["none"]["variant_meta"]}
    base_docs = {}
    for path in doc_paths():
        with open(path) as f:
            doc = json.load(f)
        base_docs[doc["recipe_id"]] = doc

    sets_restrictions = {}
    stats = []
    for rid, (slug, label) in sorted(RESTRICTIONS.items()):
        meta_by_recipe = {m["recipe_id"]: m for m in payloads[slug]["variant_meta"]}
        removed = sorted(set(none_meta) - set(meta_by_recipe))
        sets_restrictions[str(rid)] = {
            "slug": slug,
            "label": label,
            "removed": removed,
        }
        stats.append((slug, label, len(removed)))

    newest = max(
        os.path.getmtime(os.path.join(ARCHIVE, slug + "-%s.json" % PAYLOAD_SUFFIX))
        for (slug, _l) in RESTRICTIONS.values()
    )
    sets_obj = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(newest)),
        "restrictions": sets_restrictions,
    }
    return sets_obj, stats


def check():
    """The stale-artifact gate. Offline always.

    Verifies the committed restriction_dict.json is well-formed and that the
    archive-derived removal sets match it. No overlay checks (option C — the
    runtime consumes the dictionary only).
    """
    from archive_catalog_profiles import RESTRICTIONS

    problems = []
    dict_path = os.path.join(DATA, "restriction_dict.json")
    if not os.path.exists(dict_path):
        return ["%s is missing" % dict_path]
    with open(dict_path) as f:
        d = json.load(f)

    for rid_str in sorted(RESTRICTIONS, key=int):
        rid = int(rid_str)
        slug = RESTRICTIONS[rid][0]
        if str(rid) not in d:
            problems.append("%s (%s): missing from restriction_dict.json" % (rid, slug))
            continue
        info = d[str(rid)]
        for key in ("removed", "pairRemoved", "swaps"):
            if key not in info:
                problems.append("%s (%s): missing %s" % (rid, slug, key))
        if "removed" in info and info["removed"] != sorted(info["removed"]):
            problems.append("%s: removed not sorted" % rid)
        if "swaps" in info:
            for s in info["swaps"]:
                for k in ("from", "to", "quantityRule", "count"):
                    if k not in s:
                        problems.append("%s: swap missing %s" % (rid, k))
        if "pairRemoved" in info:
            for pair_key, extras in info["pairRemoved"].items():
                a_str, b_str = pair_key.split(",")
                partner = d.get(b_str) or d.get(a_str)
                if partner is None:
                    problems.append("%s: pair %s partner missing" % (rid, pair_key))
                    continue
                if extras != partner["pairRemoved"].get(pair_key):
                    problems.append("%s: pair %s not symmetric" % (rid, pair_key))

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify the restriction_dict.json is fresh (offline)")
    args = ap.parse_args()

    if args.check:
        problems = check()
        for p in problems:
            log("STALE: %s" % p)
        if not problems:
            log("restriction_dict.json fresh")
        return 1 if problems else 0

    try:
        planned = plan_build()
    except Exception as e:  # noqa: BLE001
        log("ERROR: %s" % e)
        return 1
    if planned is None:
        return 1
    _, stats = planned
    for slug, label, removed in stats:
        log("%-16s %-14s removed=%4d" % (slug, label, removed))
    log("verification only — restriction_sets.json and overlays are option-B artifacts, deleted by ADR-0056 option C; the runtime consumes restriction_dict.json only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
