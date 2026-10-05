#!/usr/bin/env python3
"""Archive the catalog's per-SETTINGS profiles (units x servings) as raw truth.

WHY THIS EXISTS
===============
`get_builder_data` does not return "the catalog". It returns the catalog
RENDERED FOR THE ACCOUNT'S CURRENT SETTINGS, and the two settings that matter
are the unit system (Metric / US) and the default serving count. Flip either in
the Mealime web app and the very same recipe comes back with different
`units`, a different `serving_count`, and re-authored quantities and prose.

Measured on 2026-10-05 against live `api.mealime.com`:

  * `recipe_id` is the ONLY stable identity. `variant id` and
    `published_recipe_uuid` are re-issued on EVERY call -- two pulls with an
    identical body returned zero id overlap. Keying anything on them is
    unsound.
  * `units` and `serving_count` come from the ACCOUNT, not the request: adding
    `"units":"Metric"` / `"serving_count":6` to the POST body changed nothing
    (byte-identical 676843-byte responses), while changing the setting in the
    app moved the whole catalog from US/6 to Metric/4.
  * A fetched DOC is immutable: re-fetching the same `published_recipe_uuid`
    later, after the setting changed, still returned its original
    `units`/`serving_count`. So a profile is a stable, archivable artifact
    identified by the uuid that named it -- but that uuid is not reproducible,
    which is exactly why the profile must be ARCHIVED, never re-derived.

So a "variant" in this catalog is not a serving-size or unit-system CHOICE
per recipe. It is one render of one recipe under one account setting. The app
needs at most the metric render it already has; the others are reference truth
for checking our display-time conversion (ADR-0047) and for the ADR that
decides whether to store more than one.

The three profiles pulled on 2026-10-05, by the OWNER's account settings:

  ==========  =========  =====================================
  label       units/sv   provenance
  ==========  =========  =====================================
  metric-6    Metric/6   the committed catalog (already in the repo)
  us-6        US/6       owner flipped the unit setting to imperial
  metric-4    Metric/4   owner set default servings to 4
  ==========  =========  =====================================

LAYOUT (all under ../mealime-media, gitignored and OUTSIDE the repo)
====================================================================

  raw_profiles/<label>/builder_data.json     the verbatim payload
  raw_profiles/<label>/recipes/<uuid>.json   each doc, named by the ONLY
                                             stable handle we were given
  raw_profiles/index.json                    label -> {units, serving_count,
                                             recipe_ids, doc count, pulled_at}

Docs are keyed by UUID, not by `recipe_id`: the uuid is what the CDN address is
built from, so it is the only name under which a doc can be RE-FETCHED or
byte-verified later. `index.json` records the `recipe_id` -> uuid map for the
cross-profile joins the analysis needs.

Note the deliberate absence of images: image URLs are per-RECIPE (the
`/recipe_variant/thumbnail/<n>/` path segment tracks the variant id, but the
recipe's picture is shared across its renders), and `sync_catalog.py` already
archives those by stem. Re-pulling them per profile would duplicate 173 MB of
webp for zero new pixels.

    python3 scripts/archive_catalog_profiles.py --builder-json A.json --label us-6
    python3 scripts/archive_catalog_profiles.py --token-file PATH --label metric-4
    python3 scripts/archive_catalog_profiles.py --index        # print the index

Stdlib only. The token is read from a FILE, never a command line (so it never
lands in a shell history or a process listing).
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BUILDER_URL = "https://api.mealime.com/api/v2/get_builder_data"
CDN_ROOT = "https://cdn-recipes.mealime.com"
SET_PROFILE_URL = "https://api.mealime.com/api/v2/set_profile"
PAYLOAD = {"source": "my-web", "client_id": "archive-profiles"}

# The account settings that re-render the catalog (ADR-0057). Verified live:
# unit_family_id 1 = Metric, 2 = US; serving_count the app itself offers is
# 2 / 4 / 6. `set_profile` responds {} and takes effect on the NEXT
# `get_builder_data` call, which then returns the WHOLE catalog re-rendered.
UNIT_FAMILY = {"metric": 1, "us": 2}
SERVING_OPTIONS = (2, 4, 6)
PROFILE_LABELS = {
    (1, sv): f"metric-{sv}" for sv in SERVING_OPTIONS
} | {(2, sv): f"us-{sv}" for sv in SERVING_OPTIONS}


MEDIA = os.path.join(os.path.dirname(ROOT), "mealime-media")
PROFILE_ROOT = os.path.join(MEDIA, "raw_profiles")
INDEX_PATH = os.path.join(PROFILE_ROOT, "index.json")

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0"
WORKERS = 8


def log(msg):
    print(msg, flush=True)


def read_token(path):
    if not path or not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read().strip()


def fetch_builder(token):
    body = json.dumps(PAYLOAD).encode()
    req = urllib.request.Request(
        BUILDER_URL,
        data=body,
        headers={
            "Authorization": "Token token=" + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def fetch_doc(uuid):
    """One doc's bytes, or None. Returns raw bytes: never re-serialize."""
    req = urllib.request.Request("%s/%s.json" % (CDN_ROOT, uuid), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def profile_dir(label):
    return os.path.join(PROFILE_ROOT, label)


def load_index():
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH) as f:
            return json.load(f)
    return {"profiles": {}}


def save_index(index):
    os.makedirs(PROFILE_ROOT, exist_ok=True)
    with open(INDEX_PATH, "w") as f:
        json.dump(index, f, indent=1, sort_keys=True)
        f.write("\n")


def describe(builder):
    """Read the profile's units/serving_count OFF THE DATA, never off --label.

    A label is a human name and can lie; the index is only useful if its
    units/serving_count were measured. `variant_meta.serving_count` is
    catalog-wide, and `units` is only on the DOCS -- so units is taken from the
    first doc we fetch and asserted to be uniform across the sample.
    """
    servings = sorted({m.get("serving_count") for m in builder["variant_meta"]})
    return servings


def archive(label, builder, skip_existing=True):
    out = profile_dir(label)
    docs_dir = os.path.join(out, "recipes")
    os.makedirs(docs_dir, exist_ok=True)

    meta_by_recipe = {m["recipe_id"]: m for m in builder["variant_meta"]}
    log("profile %s: %d variants, serving_count %s"
        % (label, len(builder["variant_meta"]), describe(builder)))

    # The payload is TRUTH: archive it verbatim, before any interpretation.
    builder_out = os.path.join(out, "builder_data.json")
    with open(builder_out, "w") as f:
        json.dump(builder, f)

    # Probe a doc first: it is the only place `units` exists.
    probe_recipe = sorted(meta_by_recipe)[0]
    probe_meta = meta_by_recipe[probe_recipe]
    try:
        probe = json.loads(fetch_doc(probe_meta["published_recipe_uuid"]).decode())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log("ERROR: probe doc failed for recipe_id %s: %s" % (probe_recipe, e))
        return None
    units = probe.get("units")
    log("profile %s: units=%s serving_count=%s (measured from a doc)"
        % (label, units, probe.get("serving_count")))

    # A doc's uuid is a PERMANENT name for that render; keep the mapping so a
    # later pull can be diffed against this one by recipe_id.
    id_map = {str(r): m["published_recipe_uuid"] for r, m in sorted(meta_by_recipe.items())}

    def one(recipe_id):
        uuid = id_map[recipe_id]
        path = os.path.join(docs_dir, uuid + ".json")
        if skip_existing and os.path.exists(path):
            return "kept"
        try:
            blob = fetch_doc(uuid)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return "error:%s" % e
        doc = json.loads(blob.decode())
        # A doc MUST belong to the recipe we asked for. A mismatch means the
        # uuid map is crossed, which would silently mis-file the archive.
        if doc.get("recipe_id") != int(recipe_id):
            return "error:recipe-mismatch(%s)" % doc.get("recipe_id")
        with open(path, "wb") as f:
            f.write(blob)
        return "archived"

    recipes = sorted(id_map, key=int)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(one, recipes))
    tally = {}
    for r in results:
        tally[r.split(":")[0]] = tally.get(r.split(":")[0], 0) + 1
    log("profile %s: docs %s" % (label, tally))
    errs = [r for r in results if r.startswith("error")]
    if errs:
        log("profile %s: %d errors, first: %s" % (label, len(errs), errs[0]))

    units_seen = {units}
    for r in recipes[: min(len(recipes), 25)]:
        p = os.path.join(docs_dir, id_map[r] + ".json")
        if os.path.exists(p):
            with open(p) as f:
                units_seen.add(json.load(f).get("units"))
    if len(units_seen) > 1:
        log("WARNING profile %s: mixed units across sampled docs: %s"
            % (label, sorted(units_seen)))

    index = load_index()
    index["profiles"][label] = {
        "units": units,
        "serving_count": describe(builder),
        "variant_count": len(builder["variant_meta"]),
        "recipe_count": len(id_map),
        "docs_archived": len(os.listdir(docs_dir)),
        "recipe_id_to_uuid": id_map,
        "pulled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "errors": len(errs),
    }
    save_index(index)
    log("profile %s: indexed (%d recipes, %d docs on disk)"
        % (label, len(id_map), len(os.listdir(docs_dir))))
    return index["profiles"][label]


def set_profile(token, unit_family, serving_count):
    """Switch the account's render profile. Effect lands on the NEXT
    `get_builder_data` call (ADR-0057 §5)."""
    body = {
        "profile": {
            "recipe_type_id": 1,
            "unit_family_id": unit_family,
            "recipe_restriction_ids": [],
            "dislike_ids": [1],
            "serving_count": serving_count,
        },
        "source": "my-web",
        "client_id": "ab0047d4-231b-480c-8e6e-f43e47fbb5d4",
    }
    req = urllib.request.Request(
        SET_PROFILE_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Token token=" + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    global PROFILE_ROOT
    global INDEX_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", help="profile name, e.g. us-6 / metric-4")
    ap.add_argument("--token-file", default=os.path.join(MEDIA, ".mealime_token"))
    ap.add_argument("--builder-json", help="use a saved builder payload instead of the API")
    ap.add_argument("--index", action="store_true", help="print the profile index and exit")
    ap.add_argument("--force", action="store_true", help="re-fetch docs already archived")
    ap.add_argument(
        "--all", action="store_true",
        help="archive ALL profiles reachable via set_profile (2 unit systems x 3 serving counts)")
    args = ap.parse_args()

    if args.index:
        index = load_index()
        if not index["profiles"]:
            log("no profiles archived yet (looked in %s)" % PROFILE_ROOT)
            return 1
        for label, p in sorted(index["profiles"].items()):
            log("%-10s units=%-7s servings=%-8s variants=%-5d docs=%d"
                % (label, p["units"], p["serving_count"], p["variant_count"], p["docs_archived"]))
        return 0

    token = read_token(args.token_file) if not args.builder_json else None
    if args.all:
        if not token:
            log("ERROR: --all needs a live token at %s" % args.token_file)
            return 1
        results = []
        for (uf, sv), label in sorted(PROFILE_LABELS.items()):
            log("\n=== profile %s (unit_family=%d serving=%d) ===" % (label, uf, sv))
            set_profile(token, uf, sv)
            time.sleep(2)
            fresh = fetch_builder(token)
            result = archive(label, fresh, skip_existing=not args.force)
            results.append((label, result))
        log("\n=== summary ===")
        failed = [lab for lab, r in results if r is None or r["errors"]]
        for lab, r in results:
            log("  %-10s %s" % (lab, "FAILED" if r is None or r["errors"]
                                else "%d docs" % r["docs_archived"]))
        return 1 if failed else 0

    if not args.label:
        ap.error("--label (or --all) is required (try --index to list what is archived)")

    if args.builder_json:
        log("builder: reading %s" % args.builder_json)
        with open(args.builder_json) as f:
            fresh = json.load(f)
    else:
        if not token:
            log("ERROR: no token at %s -- pass --token-file or --builder-json" % args.token_file)
            return 1
        log("builder: fetching (token from file, %d chars)" % len(token))
        fresh = fetch_builder(token)

    result = archive(args.label, fresh, skip_existing=not args.force)
    return 0 if result and not result["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())