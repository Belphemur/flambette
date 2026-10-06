#!/usr/bin/env python3
"""Find the REAL restriction-composition pattern upstream implements.

WHY THIS EXISTS
===============
The twelve single restrictions are archived, built and shipped (ADR-0056).
The owner's directive (2026-10-07): archive ALL 66 two-restriction
combinations from upstream, then run analysis "to see how we can find the
real pattern instead of hardcoding — basically figuring out the replacement
of ingredients". The runtime must never compose or hardcode; whatever rule
upstream implements has to be MEASURED from its own renders first.

This script joins every archived payload — none, the twelve singles, the 66
combos (`archive_catalog_profiles.py --combinations`) and the all-free
extreme — on the STABLE `recipe_id`, and answers with numbers:

  1. REMOVAL COMPOSITION  is removed(A,B) == removed(A) | removed(B)?
     (the union was the working assumption; count and characterize the
     exceptions).
  2. SWAP COMPOSITION     for a recipe surviving the pair, does the pair
     apply BOTH singles' substitutions, only one, or a different substitute
     altogether?
  3. SUBSTITUTION DICTIONARY  across all 79 payloads, cluster the
     (from → to) pairs: is the substitute fixed per ingredient globally,
     per recipe, per quantity class?
  4. QUANTITY BEHAVIOUR   when a substitute's quantity differs from the
     base's, is the difference predictable (same unit same number, scaled,
     unit change)?

Line-level events are extracted from the restricted DOCS (the build's doc
cache under docs-metric/ — run `build_restriction_sets.py` first); the
payload census (`variant_meta.ingredient_names`) backs the name-level and
removal-level joins. Where a doc is missing from the cache the script
degrades to census-level for that recipe and reports its coverage.

TOOLING: stdlib only. The brief allows `uv run --with pandas,polars,…` for
this script; stdlib was chosen deliberately — the tables are small (the
joins are dict lookups over ~80 x ~2700 recipe ids), a dependency would not
change a single number, and byte-identical doc output across machines is
the property the committed analysis doc depends on. It runs identically
under `uv run --no-project scripts/analyze_restriction_combinations.py`.

    python3 scripts/analyze_restriction_combinations.py            # full run
    python3 scripts/analyze_restriction_combinations.py --quiet    # no console

Outputs (both committed):
  docs/analysis/restriction-compositions.md      the readable findings
  docs/analysis/restriction-compositions.json    the machine-readable summary
"""

import argparse
import json
import logging
import os
import re
import sys
from collections import Counter, defaultdict
from statistics import median

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# The restricted-doc cache lives in the gitignored archive, outside the repo
# (`build_restriction_sets.py` used to own this path; option C removed the
# overlay machinery — the analysis reads the RAW cache directly).
ARCHIVE = os.path.join(os.path.dirname(ROOT), "mealime-media", "raw_profiles", "restrictions")
DOC_CACHE = os.path.join(ARCHIVE, "docs-metric")
sys.path.insert(0, HERE)

import build_restriction_sets as B  # noqa: E402  (loader, doc cache, RESTRICTIONS)
from archive_catalog_profiles import ALL_RESTRICTION_IDS, RESTRICTIONS  # noqa: E402

OUT_DIR = os.path.join(ROOT, "docs", "analysis")
OUT_MD = os.path.join(OUT_DIR, "restriction-compositions.md")
OUT_JSON = os.path.join(OUT_DIR, "restriction-compositions.json")

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.info

# ---------- naming / normalisation ----------

_NONWORD = re.compile(r"[^a-z0-9 ]+")
_SPACES = re.compile(r"\s+")


def name_key(name):
    """A forgiving normalised name for matching lines across renders.

    The runtime's `nameKey` (src/lib/grocery.ts) is the authority for KEYS;
    here we only need matching for EVENT extraction, so lowercase + strip
    punctuation + collapse spaces is enough (and deliberately NOT identical
    to nameKey — this script never produces keys).
    """
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


# ---------- payload / doc plumbing ----------


def combo_pairs():
    """The 66 sorted (a, b) id pairs (--combinations archive layout)."""
    ids = sorted(RESTRICTIONS)
    return [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]


def load_everything():
    """The RAW archive inputs — never the committed control plane.

    Reads ../mealime-media/raw_profiles/restrictions/ directly: the none
    baseline, the twelve singles, all-free, and the 66 combos/-m6 payloads;
    base docs come from the repo's committed catalog; restricted docs come
    from the build's cache (docs-metric/<slug>/ and docs-metric/combos/
    <a>-<b>/). All-or-nothing: a partial archive aborts the analysis rather
    than publishing partial numbers.
    """
    archive = os.path.join(os.path.dirname(ROOT), "mealime-media",
                           "raw_profiles", "restrictions")
    suffix = "m6"
    expected = (["none"]
                + [RESTRICTIONS[r][0] for r in sorted(RESTRICTIONS)]
                + ["all-free"]
                + ["combos/%d-%d" % (a, b) for a, b in combo_pairs()])
    paths = {}
    for slug in expected:
        if slug.startswith("combos/"):
            a, b = (int(x) for x in slug.split("/")[1].split("-"))
            paths[slug] = os.path.join(archive, "combos", "%d-%d-%s.json" % (a, b, suffix))
        else:
            paths[slug] = os.path.join(archive, "%s-%s.json" % (slug, suffix))
    missing = [s for s, p in paths.items() if not os.path.exists(p)]
    if missing:
        log("ERROR: %d/%d archive payloads missing under %s (run the archiver): %s..."
            % (len(missing), len(expected), archive, missing[:5]))
        return None, None
    payloads = {}
    for slug, path in paths.items():
        with open(path) as f:
            payloads[slug] = json.load(f)
    base_docs = {}
    recipes_dir = os.path.join(ROOT, "public", "data", "recipes")
    for n in sorted(os.listdir(recipes_dir)):
        if not n.endswith(".json") or n.endswith(".timer.json"):
            continue
        with open(os.path.join(recipes_dir, n)) as f:
            doc = json.load(f)
        base_docs[doc["recipe_id"]] = doc
    return payloads, base_docs


def census(payload):
    return {m["recipe_id"]: list(m.get("ingredient_names") or []) for m in payload["variant_meta"]}


def rids(payload):
    return frozenset(m["recipe_id"] for m in payload["variant_meta"])


def doc_cached(slug, uuid):
    return os.path.exists(os.path.join(DOC_CACHE, slug, uuid + ".json"))


def uuid_of(payload, recipe_id):
    for m in payload["variant_meta"]:
        if m["recipe_id"] == recipe_id:
            return m["published_recipe_uuid"]
    return None

def pair_lines(base, ov):
    """Mirror of the runtime's pairing (restrictions.ts pairOverlayToBase).

    Returns (pairs, ov_left, base_left): pairs is {ov_index: base_index}.
    base/ov rows are (key, name, quantity) triples.
    """
    used_b = set()
    pairs = {}
    # pass 1: exact key, greedy in order (consumes duplicates correctly)
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
    open_ov = [j for j, (k, _n, _q) in enumerate(ov) if j not in pairs and k]
    open_base = [i for i, (k, _n, _q) in enumerate(base) if i not in used_b and k]
    # pass 1b: unique containment
    for j in open_ov:
        k = ov[j][0]
        cands = [i for i in open_base
                 if i not in used_b and (base[i][0] in k or k in base[i][0])]
        if len(cands) == 1:
            pairs[j] = cands[0]
            used_b.add(cands[0])
    open_ov = [j for j in open_ov if j not in pairs]
    open_base = [i for i in open_base if i not in used_b]
    # pass 2: in-order leftovers, both quantities unique among their own side
    ovq = Counter(ov[j][2].strip() for j in open_ov)
    baseq = Counter(base[i][2].strip() for i in open_base)
    for n in range(min(len(open_ov), len(open_base))):
        j, i = open_ov[n], open_base[n]
        qo, qb = ov[j][2].strip(), base[i][2].strip()
        if qo == qb and ovq[qo] == 1 and baseq[qb] == 1:
            pairs[j] = i
            used_b.add(i)
    ov_left = [j for j, (_k, _n, _q) in enumerate(ov) if j not in pairs]
    base_left = [i for i, (_k, _n, _q) in enumerate(base) if i not in used_b]
    return pairs, ov_left, base_left


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


def uuid_map(payload):
    return {m["recipe_id"]: m["published_recipe_uuid"] for m in payload["variant_meta"]}


def payload_events(slug, cens, uuids, base_docs, none_meta):
    """{recipe_id: events} for every changed recipe of one payload.

    Doc-level when the restricted doc is cached, census-level (name multiset
    diff, no quantities) otherwise; returns (events, doc_level, changed) so
    the caller can report its coverage.
    """
    out = {}
    n_docs = 0
    changed = 0
    for r, names in cens.items():
        if r not in none_meta or names == none_meta[r]:
            continue
        if r not in base_docs:
            continue
        changed += 1
        uuid = uuids.get(r)
        if uuid and doc_cached(slug, uuid):
            with open(os.path.join(DOC_CACHE, slug, uuid + ".json")) as f:
                rdoc = json.load(f)
            out[r] = events_for_doc(base_docs[r], rdoc)
            n_docs += 1
        else:
            # census-level: multiset diff, no alignment, no quantities
            bc = Counter(name_key(n) for n in none_meta[r])
            pc = Counter(name_key(n) for n in names)
            evs = []
            for k in bc - pc:
                evs.append({"kind": "removed", "from_key": k})
            for k in pc - bc:
                evs.append({"kind": "added", "to_key": k})
            out[r] = evs
    return out, n_docs, changed


# ---------- allergen attribution (for removal-composition extras) ----------

FAMILY_TOKENS = {
    1: r"\b(wheat|barley|rye|flour|pasta|bread|crumb|tortilla|couscous|oat|seitan|"
       r"soy sauce|beer|bulgur|semolina|spelt|farro|noodle)\b",
    2: r"\b(milk|butter|cheese|cream|yogurt|yoghurt|whey|ghee|casein)\b",
    3: r"\b(fish|anchov|tuna|salmon|cod|halibut|trout|sardine|mackerel|fish sauce)\b",
    4: r"\b(shrimp|prawn|crab|lobster|clam|mussel|oyster|scallop|shellfish|squid)\b",
    5: r"\bpeanut\b",
    6: r"\b(almond|cashew|walnut|pecan|hazelnut|pistachio|macadamia|pine nut|"
       r"nut\b|nut butter|nut milk)\b",
    9: r"\b(soy|tofu|edamame|miso|tempeh|tamari)\b",
    10: r"\b(tomato|pepper|chili|chilli|paprika|eggplant|aubergine|potato|cayenne|"
        r"jalape|sriracha|harissa)\b",
    11: r"\b(egg|mayonnaise|mayo|aioli)\b",
    12: r"\b(sesame|tahini)\b",
    13: r"\bmustard\b",
    14: r"\b(wine|vinegar|sulfite|sulphite|dried fruit|sauerkraut)\b",
}


def attribute(names, ids):
    """Which of the pair's families do the recipe's ingredient names mention?"""
    text = " ".join(names).lower()
    hits = []
    for rid in ids:
        if re.search(FAMILY_TOKENS[rid], text):
            hits.append(rid)
    return hits


# ---------- the analyses ----------


def analyze_removal(payloads, none_r, singles_r):
    """Q1: removed(A,B) vs removed(A) | removed(B)."""
    rows = []
    for a, b in combo_pairs():
        combo = payloads["combos/%d-%d" % (a, b)]
        removed = none_r - rids(combo)
        union = singles_r[a] | singles_r[b]
        extra = sorted(removed - union)
        missing = sorted(union - removed)
        rows.append({"a": a, "b": b, "removed": len(removed),
                     "union": len(union), "extras": len(extra),
                     "missing": len(missing), "extra_ids": extra[:8],
                     "all_extra_ids": extra, "missing_ids": missing[:8]})
    exact = sum(1 for r in rows if r["extras"] == 0 and r["missing"] == 0)
    allfree_removed = none_r - rids(payloads["all-free"])
    combo_removeds = {tuple(sorted([r["a"], r["b"]])): none_r - rids(payloads["combos/%d-%d" % (r["a"], r["b"])])
                      for r in rows}
    total_extra = sum(r["extras"] for r in rows)
    total_missing = sum(r["missing"] for r in rows)
    inside_allfree = all(rm <= allfree_removed for rm in combo_removeds.values())
    return {
        "rows": rows, "exact": exact, "total_extras": total_extra,
        "total_missing": total_missing,
        "allfree_removed": len(allfree_removed),
        "combos_inside_allfree": inside_allfree,
        "union_of_singles_removed": len(set().union(*singles_r.values())),
    }


def swap_classes(combo_events, ev_a, ev_b):
    """Q2 classification for ONE recipe's pair events.

    Returns per-swap-event classes plus a recipe-level verdict.
    """
    classes = []
    a_by_from = defaultdict(set)
    b_by_from = defaultdict(set)
    for e in ev_a or []:
        if e["kind"] == "swap":
            a_by_from[e["from_key"]].add(e["to_key"])
    for e in ev_b or []:
        if e["kind"] == "swap":
            b_by_from[e["from_key"]].add(e["to_key"])
    pair_froms = {e["from_key"] for e in combo_events if e["kind"] == "swap"}
    for e in combo_events:
        if e["kind"] != "swap":
            continue
        F, T = e["from_key"], e["to_key"]
        in_a, in_b = T in a_by_from.get(F, ()), T in b_by_from.get(F, ())
        if in_a and in_b:
            c = "both-agree"
        elif in_a:
            c = "from-single-a" if not b_by_from.get(F) else "a-over-b"
        elif in_b:
            c = "from-single-b" if not a_by_from.get(F) else "b-over-a"
        else:
            c = "pair-specific"
        classes.append(c)
    # singles' swaps the pair did NOT make
    dropped = 0
    for src in (a_by_from, b_by_from):
        for F, tos in src.items():
            if F not in pair_froms:
                dropped += len(tos)
    novel = bool(combo_events) and ev_a is None and ev_b is None
    return classes, dropped, novel


def collect_events(payloads, base_docs, none_meta):
    """Events for every payload, doc-level where the cache allows."""
    evs = {}
    coverage = {}
    changed_counts = {}
    for rid, (slug, _label) in sorted(RESTRICTIONS.items()):
        e, n, changed = payload_events(slug, census(payloads[slug]),
                                       uuid_map(payloads[slug]), base_docs, none_meta)
        evs[slug] = e
        coverage[slug] = n
        changed_counts[slug] = changed
    for a, b in combo_pairs():
        slug = "combos/%d-%d" % (a, b)
        e, n, changed = payload_events(slug, census(payloads[slug]),
                                       uuid_map(payloads[slug]), base_docs, none_meta)
        evs[slug] = e
        coverage[slug] = n
        changed_counts[slug] = changed
    e, n, changed = payload_events("all-free", census(payloads["all-free"]),
                                   uuid_map(payloads["all-free"]), base_docs, none_meta)
    evs["all-free"] = e
    coverage["all-free"] = n
    changed_counts["all-free"] = changed
    return evs, coverage, changed_counts


def swap_composition(payloads, none_meta, evs):
    """Q2 across all 66 combos."""
    per_combo = {}
    cls_total = Counter()
    dropped_total = 0
    novel_total = 0
    examples = defaultdict(list)
    for a, b in combo_pairs():
        slug = "combos/%d-%d" % (a, b)
        slug_a, slug_b = RESTRICTIONS[a][0], RESTRICTIONS[b][0]
        c = Counter()
        dropped = novel = union_checked = union_exact = 0
        for r, c_events in evs[slug].items():
            ev_a = evs[slug_a].get(r)
            ev_b = evs[slug_b].get(r)
            # a recipe is "changed by single X" iff X has events for it
            ev_a = ev_a if ev_a else None
            ev_b = ev_b if ev_b else None
            classes, d, novel_r = swap_classes(c_events, ev_a, ev_b)
            c.update(classes)
            dropped += d
            novel += 1 if novel_r else 0
            if ev_a or ev_b:
                union_checked += 1
                want = defaultdict(Counter)
                for e in (ev_a or []) + (ev_b or []):
                    if e["kind"] == "swap":
                        want[(e["from_key"], e["to_key"])][e["kind"]] += 1
                got = defaultdict(Counter)
                for e in c_events:
                    if e["kind"] == "swap":
                        got[(e["from_key"], e["to_key"])][e["kind"]] += 1
                if want == got:
                    union_exact += 1
            if "pair-specific" in classes and len(examples[(a, b)]) < 3:
                examples[(a, b)].append(r)
        per_combo["%d,%d" % (a, b)] = dict(c)
        cls_total.update(c)
        dropped_total += dropped
        novel_total += novel
        if union_checked:
            per_combo["%d,%d" % (a, b)]["union_checked"] = union_checked
            per_combo["%d,%d" % (a, b)]["union_exact"] = union_exact
    return {
        "per_combo": per_combo,
        "classes_total": dict(cls_total),
        "dropped_single_swaps": dropped_total,
        "novel_recipes": novel_total,
        "pair_specific_examples": {"%d,%d" % k: v for k, v in examples.items()},
    }


def dictionary(evs):
    """Q3: the (from -> to) substitution dictionary across ALL payloads."""
    per_from_to = Counter()          # (from_key, to_key) -> event count
    per_from_to_recipes = defaultdict(set)   # for distinct-recipe counts
    per_from_context = defaultdict(Counter)  # from_key -> {to_key: n} within singles
    per_context_from = defaultdict(set)      # slug -> {from_key}
    for slug, by_recipe in evs.items():
        for r, events in by_recipe.items():
            for e in events:
                if e["kind"] != "swap":
                    continue
                per_from_to[(e["from_key"], e["to_key"])] += 1
                per_from_to_recipes[(e["from_key"], e["to_key"])].add(r)
                per_from_context[e["from_key"]][e["to_key"]] += 1
    diversity = Counter()
    for F, tos in per_from_context.items():
        diversity[len(tos)] += 1
    # from_key -> {to_key: count} per single (NOT combo) payloads, for the
    # per-ingredient substitute spread table
    per_from_context_single: dict[str, Counter] = defaultdict(Counter)
    for slug, by_recipe in evs.items():
        if slug.startswith("combos/") or slug == "all-free":
            continue
        for _r, events in by_recipe.items():
            for e in events:
                if e["kind"] != "swap":
                    continue
                per_from_context_single[e["from_key"]][e["to_key"]] += 1
    top = sorted(
        per_from_to_recipes.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:40]
    return {
        "distinct_from": len(per_from_context),
        "distinct_pairs": len(per_from_to),
        "diversity": dict(sorted(diversity.items())),
        "top_pairs": [
            {"from": F, "to": T, "events": per_from_to[(F, T)],
             "recipes": len(rs)} for (F, T), rs in top],
        "per_from_context": {
            F: dict(tos.most_common(12))
            for F, tos in sorted(per_from_context.items(),
                                 key=lambda kv: -sum(kv[1].values()))[:40]},
    }


def quantity_behaviour(evs):
    """Q4: when a substitute's quantity differs from the base's."""
    rel = Counter()
    ratios = []
    per_from_scaled = defaultdict(list)
    unit_changes = Counter()
    examples = defaultdict(list)
    for slug, by_recipe in evs.items():
        for _r, events in by_recipe.items():
            for e in events:
                if e["kind"] != "swap":
                    continue
                r = qty_relation(e.get("qty_base"), e.get("qty_new"))
                rel[r] += 1
                if r == "scaled":
                    nb, ub = parse_qty(e.get("qty_base") or "")
                    nn, _un = parse_qty(e.get("qty_new") or "")
                    if nb and nn and nb > 0:
                        ratios.append(nn / nb)
                        per_from_scaled[e["from_key"]].append(nn / nb)
                elif r == "unit-change":
                    unit_changes[(e.get("qty_base"), e.get("qty_new"))] += 1
                if r in ("scaled", "unit-change", "re-authored") and len(examples[r]) < 12:
                    examples[r].append({"from": e["from"], "to": e["to"],
                                        "qty_base": e.get("qty_base"),
                                        "qty_new": e.get("qty_new")})
    med = median(ratios) if ratios else None
    return {
        "relations": dict(rel),
        "scaled_ratio_median": med,
        "ratio_p10_p90": (
            sorted(ratios)[max(0, int(0.1 * len(ratios)))],
            sorted(ratios)[min(len(ratios) - 1, int(0.9 * len(ratios)))],
        ) if ratios else None,
        "top_unit_changes": [
            {"base": k[0], "new": k[1], "n": n}
            for k, n in unit_changes.most_common(15)],
        "per_from_median_ratio": {
            F: median(v) for F, v in sorted(per_from_scaled.items(),
                                            key=lambda kv: -len(kv[1]))[:20]
            if len(v) >= 3},
        "examples": {k: v for k, v in examples.items()},
    }


# ---------- output ----------


def pct(n, d):
    return "%.1f%%" % (100.0 * n / d) if d else "n/a"


def write_md(summary, slug_label, extras_detail):
    L = []
    w = L.append
    w("# Restriction compositions — what upstream actually does with two active restrictions")
    w("")
    w("Generated by `scripts/analyze_restriction_combinations.py` over the archived")
    w("renders: `none`, the twelve singles, all 66 two-restriction combinations and")
    w("the all-free extreme (metric / 6 servings, ids per ADR-0056). Joins are on the")
    w("stable `recipe_id`; line-level events come from the restricted docs in the")
    w("build's cache (run `build_restriction_sets.py` first). Numbers below are")
    w("measured, not assumed — this doc is the input to the composed-overlays design")
    w("decision recorded in ADR-0056.")
    w("")
    doc_level = sum(summary["coverage"].values())
    census_level = sum(summary["changed_counts"].values()) - doc_level
    w("Line-level event extraction: **%s** changed (payload, recipe) pairs analysed"
      % ("{:,}".format(doc_level)))
    w("at doc level (restricted docs in the build's cache); **%s** fell back to the" % ("{:,}".format(census_level)))
    w("payload census (name multiset diff, no quantities).")
    w("")

    # Q1
    r1 = summary["removal"]
    w("## 1. Removal composition — is `removed(A,B) == removed(A) ∪ removed(B)`?")
    w("")
    w("- exact (pair == union): **%d / 66 combos** (%s)" % (r1["exact"], pct(r1["exact"], 66)))
    w("- recipes removed under the pair but allowed under BOTH singles")
    w("  (composition effects): **%d** total across all combos" % r1["total_extras"])
    w("- recipes removed under a single but PRESENT under the pair")
    w("  (union-rule violations): **%d** total" % r1["total_missing"])
    w("- every combo's removed set sits inside all-free's (%s recipes): **%s**"
      % (r1["allfree_removed"], r1["combos_inside_allfree"]))
    w("- union of all twelve singles' removed sets: **%d recipes**"
      % r1["union_of_singles_removed"])
    w("")
    nonexact = [r for r in summary["removal_rows"] if r["extras"] or r["missing"]]
    w("Combos that deviate from the union:")
    w("")
    w("| pair | removed | union | extras | missing |")
    w("| --- | ---: | ---: | ---: | ---: |")
    for r in nonexact:
        w("| %d+%d | %d | %d | %d | %d |" % (r["a"], r["b"], r["removed"], r["union"],
                                             r["extras"], r["missing"]))
    w("")
    w("Characterisation of the extras (recipes the pair removes though both singles")
    w("allowed them): for each, which of the pair's allergen families its")
    w("unrestricted ingredient names still mention (keyword attribution — the")
    w("family tables are heuristics, not upstream's rules):")
    w("")
    w("| pair | extras | attribution of extras |")
    w("| --- | ---: | --- |")
    for r in nonexact:
        if not r["extras"]:
            continue
        key = "%d+%d" % (r["a"], r["b"])
        w("| %s | %d | %s |" % (key, r["extras"], extras_detail.get(key, "-")))
    w("")
    if r1["total_missing"]:
        w("Union-rule violations (a single removed a recipe the pair kept) — the")
        w("pair render is NOT always a subset of each single's removed union:")
        w("")
        w("| pair | missing | example ids |")
        w("| --- | ---: | --- |")
        for r in nonexact:
            if r["missing"]:
                w("| %d+%d | %d | %s |" % (r["a"], r["b"], r["missing"],
                                           ", ".join(map(str, r["missing_ids"][:5])) or "-"))
        w("")

    # Q2
    r2 = summary["swaps"]
    cls = r2["classes_total"]
    total_cls = sum(cls.values())
    w("## 2. Swap composition — how the pair's substitutions relate to its singles'")
    w("")
    w("Per swap EVENT observed in a pair render (%s events):" % ("{:,}".format(total_cls)))
    w("")
    w("| class | n | share | meaning |")
    w("| --- | ---: | ---: | --- |")
    meanings = {
        "both-agree": "both singles substitute F→T identically; the pair keeps it",
        "from-single-a": "the pair applies single a's substitute (b never swapped F)",
        "from-single-b": "the pair applies single b's substitute (a never swapped F)",
        "a-over-b": "both singles swapped F, differently; the pair picked a's",
        "b-over-a": "both singles swapped F, differently; the pair picked b's",
        "pair-specific": "the pair's substitute appears under NEITHER single",
    }
    for k in ["both-agree", "from-single-a", "from-single-b", "a-over-b", "b-over-a",
              "pair-specific"]:
        w("| %s | %s | %s | %s |" % (k, cls.get(k, 0), pct(cls.get(k, 0), total_cls),
                                     meanings[k]))
    w("")
    w("- single swaps the pair DROPPED (F unchanged under the pair though a single")
    w("  substituted it): **%s** events" % ("{:,}".format(r2["dropped_single_swaps"])))
    w("- recipes changed under the pair but under NEITHER single (novel pair")
    w("  reworkings): **%s**" % ("{:,}".format(r2["novel_recipes"])))
    w("")
    union_rows = [(k, v) for k, v in r2["per_combo"].items()
                  if v.get("union_checked")]
    ue = sum(v.get("union_exact", 0) for _k, v in union_rows)
    uc = sum(v.get("union_checked", 0) for _k, v in union_rows)
    w("Recipe-level event-set equality: the pair's swap set equals the UNION of its")
    w("two singles' swap sets for **%s / %s** surviving recipes changed by at least "
      % ("{:,}".format(ue), "{:,}".format(uc)))
    w("one single (%s)." % pct(ue, uc))
    w("")

    # Q3
    r3 = summary["dictionary"]
    w("## 3. The substitution dictionary")
    w("")
    w("- distinct `from` ingredients across all payloads: **%d**" % r3["distinct_from"])
    w("- distinct (from → to) pairs: **%d**" % r3["distinct_pairs"])
    w("- from-ingredients by number of DISTINCT substitutes (across every payload):")
    w("")
    w("| #substitutes | #from-ingredients |")
    w("| ---: | ---: |")
    for n_from, cnt in sorted(r3["diversity"].items()):
        w("| %s | %s |" % (n_from, cnt))
    w("")
    w("Top (from → to) pairs by distinct recipes:")
    w("")
    w("| from | to | recipes | events |")
    w("| --- | --- | ---: | ---: |")
    for p in r3["top_pairs"][:30]:
        w("| %s | %s | %d | %d |" % (p["from"] or "∅", p["to"], p["recipes"], p["events"]))
    w("")
    w("The per-ingredient substitute spread under the singles (is F→T fixed or")
    w("per-recipe?): top `from` ingredients with their substitute distribution:")
    w("")
    w("| from ingredient | substitutes (recipe events) |")
    w("| --- | --- |")
    for F, tos in list(r3["per_from_context"].items())[:25]:
        pretty = ", ".join("%s (%d)" % (T, n) for T, n in tos.items())
        w("| %s | %s |" % (F or "∅", pretty))
    w("")

    # Q4
    r4 = summary["quantities"]
    rel = r4["relations"]
    total_rel = sum(rel.values())
    w("## 4. Quantity behaviour of substitutions")
    w("")
    w("Per swap event with quantities (%s events):" % ("{:,}".format(total_rel)))
    w("")
    w("| relation | n | share |")
    w("| --- | ---: | ---: |")
    for k in ["same", "spelling", "scaled", "unit-change", "re-authored", "unparseable"]:
        w("| %s | %s | %s |" % (k, rel.get(k, 0), pct(rel.get(k, 0), total_rel)))
    w("")
    if r4.get("scaled_ratio_median") is not None:
        p10, p90 = r4["ratio_p10_p90"]
        w("Scaled events' ratio (new/base): median **%.3f**, p10 %.3f, p90 %.3f."
          % (r4["scaled_ratio_median"], p10, p90))
    w("")
    if r4["per_from_median_ratio"]:
        w("Median ratio per `from` ingredient (≥3 scaled events):")
        w("")
        w("| from | median ratio |")
        w("| --- | ---: |")
        for F, m in r4["per_from_median_ratio"].items():
            w("| %s | %.3f |" % (F, m))
        w("")
    if r4["top_unit_changes"]:
        w("Most common unit changes (base → new):")
        w("")
        w("| base | new | n |")
        w("| --- | --- | ---: |")
        for u in r4["top_unit_changes"][:10]:
            w("| %s | %s | %d |" % (u["base"], u["new"], u["n"]))
        w("")

    # findings
    w("## Findings (the one-paragraph version)")
    w("")
    f = summary["findings"]
    for line in f:
        w("- %s" % line)
    w("")
    with open(OUT_MD, "w") as fh:
        fh.write("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    if args.quiet:
        logging.getLogger().setLevel(logging.WARNING)

    payloads, base_docs = load_everything()
    if payloads is None:
        return 1
    none_payload = payloads["none"]
    none_r = rids(none_payload)
    none_meta = census(none_payload)

    singles_r = {rid: none_r - rids(payloads[slug])
                 for rid, (slug, _l) in RESTRICTIONS.items()}

    log("collecting events (docs from the build cache)…")
    evs, coverage, changed_counts = collect_events(payloads, base_docs, none_meta)

    log("Q1 removal composition…")
    r1 = analyze_removal(payloads, none_r, singles_r)
    # characterise extras: attribute family tokens in the none census
    extras_detail = {}
    for row in r1["rows"]:
        if not row["extras"]:
            continue
        attr = Counter()
        for rid in row["all_extra_ids"]:
            hits = attribute(none_meta.get(rid, []), (row["a"], row["b"]))
            attr["/".join(RESTRICTIONS[h][1] for h in hits) or "no-token"] += 1
        extras_detail["%d+%d" % (row["a"], row["b"])] = (
            ", ".join("%s×%d" % (k, v) for k, v in attr.most_common(4)))

    log("Q2 swap composition…")
    r2 = swap_composition(payloads, none_meta, evs)

    log("Q3 dictionary…")
    r3 = dictionary(evs)

    log("Q4 quantities…")
    r4 = quantity_behaviour(evs)

    # headline findings, computed from the measured numbers
    cls = r2["classes_total"]
    total_cls = sum(cls.values()) or 1
    r1_exact_share = pct(r1["exact"], 66)
    findings = []
    findings.append(
        "Removal is UNION-shaped: %s of the 66 pairs remove exactly the union of "
        "their singles' sets; %d recipes across all pairs are extra removals "
        "(composition effects) and %d are union-rule violations."
        % (r1_exact_share, r1["total_extras"], r1["total_missing"]))
    both = cls.get("both-agree", 0) + cls.get("from-single-a", 0) + \
        cls.get("from-single-b", 0) + cls.get("a-over-b", 0) + cls.get("b-over-a", 0)
    findings.append(
        "Substitution composition: %s of pair swap events trace to the singles' "
        "own substitutes (both-agree %s, from-a %s, from-b %s, a-over-b %s, "
        "b-over-a %s); %s are pair-specific substitutes upstream only renders "
        "under the combination."
        % (pct(both, total_cls),
           pct(cls.get("both-agree", 0), total_cls),
           pct(cls.get("from-single-a", 0), total_cls),
           pct(cls.get("from-single-b", 0), total_cls),
           pct(cls.get("a-over-b", 0), total_cls),
           pct(cls.get("b-over-a", 0), total_cls),
           pct(cls.get("pair-specific", 0), total_cls)))
    fixed = r3["diversity"].get(1, 0)
    findings.append(
        "Dictionary: %d of %d from-ingredients have exactly ONE substitute "
        "across every payload — the swap table is largely fixed per ingredient, "
        "with %d ingredients showing per-recipe (or per-combination) choice."
        % (fixed, r3["distinct_from"], r3["distinct_from"] - fixed))
    rel = r4["relations"]
    total_rel = sum(rel.values()) or 1
    findings.append(
        "Quantities: %s of swaps keep the base quantity string verbatim; %s are "
        "same-unit rescales (median ratio %.3f), %s change units, %s are fully "
        "re-authored."
        % (pct(rel.get("same", 0) + rel.get("spelling", 0), total_rel),
           pct(rel.get("scaled", 0), total_rel),
           r4.get("scaled_ratio_median") or 0,
           pct(rel.get("unit-change", 0), total_rel),
           pct(rel.get("re-authored", 0), total_rel)))

    summary = {
        "generated_by": "scripts/analyze_restriction_combinations.py",
        "payloads": {
            "none": len(none_r),
            "singles": {str(rid): len(none_r - singles_r[rid]) for rid in sorted(singles_r)},
            "combos": {"%d,%d" % (a, b): len(none_r - rids(payloads["combos/%d-%d" % (a, b)]))
                       for a, b in combo_pairs()},
            "all_free": len(none_r - rids(payloads["all-free"])),
        },
        "coverage": coverage,
        "changed_counts": changed_counts,
        "removal": {k: v for k, v in r1.items() if k != "rows"},
        "removal_rows": [
            {k: v for k, v in r.items()} for r in r1["rows"]],
        "swaps": r2,
        "dictionary": r3,
        "quantities": r4,
        "findings": findings,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_JSON, "w") as f:
        json.dump(summary, f, indent=1, sort_keys=True)
        f.write("\n")
    write_md(summary, RESTRICTIONS, extras_detail)
    log("wrote %s and %s" % (OUT_MD, OUT_JSON))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())