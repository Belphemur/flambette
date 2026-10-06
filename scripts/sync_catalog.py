#!/usr/bin/env python3
"""Sync the frozen Mealime catalog: docs, images (webp) and builder_data.

The catalog is the ONE thing this app cannot work without — it is baked into
the repo so the SPA never talks to a mealime.com host at runtime (enforced by
e2e). This script brings that baked data up to date WITHOUT redoing work:

  * raw truth  -> ../mealime-media/raw_recipes/<variantId>.json   (archive)
  * app payload-> public/data/recipes/<variantId>.json           (verbatim copy)
  * raw images -> ../mealime-media/raw_images/<stem>.jpeg        (archive)
  * app images -> public/img/recipes/<stem>.webp                 (PIL-encoded)
  * metadata   -> public/data/builder_data.json                  (merged)

It is INCREMENTAL by design: anything already present is left untouched, so a
re-run costs one API call (the builder payload) plus HEAD checks. Pass
--verify to re-fetch every doc and report drift without writing.

Sources (no auth needed for either):
  * builder metadata : POST api.mealime.com/api/v2/get_builder_data (token)
  * recipe doc       : GET  cdn-recipes.mealime.com/<published_recipe_uuid>.json
  * image            : GET  the thumbnail/presentation URL in variant_meta

Stdlib + Pillow only (Pillow is the sole dependency: it does the webp encode).

    python3 scripts/sync_catalog.py                 # incremental sync
    python3 scripts/sync_catalog.py --verify        # report drift only
    python3 scripts/sync_catalog.py --token-file PATH

The token is read from a FILE, never a command line, so it never lands in a
shell history or a process listing. Default location:
../mealime-media/.mealime_token
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BUILDER_URL = "https://api.mealime.com/api/v2/get_builder_data"
CDN_ROOT = "https://cdn-recipes.mealime.com"
PAYLOAD = {"source": "my-web", "client_id": "f4590t00mx4"}

DOC_DIR = os.path.join(ROOT, "public", "data", "recipes")
BUILDER_PATH = os.path.join(ROOT, "public", "data", "builder_data.json")
IMG_DIR = os.path.join(ROOT, "public", "img", "recipes")
MEDIA = os.path.join(os.path.dirname(ROOT), "mealime-media")
RAW_DOC_DIR = os.path.join(MEDIA, "raw_recipes")
RAW_IMG_DIR = os.path.join(MEDIA, "raw_images")

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0"
WORKERS = 8


def log(msg):
    print(msg, flush=True)


def read_token(path):
    if not os.path.exists(path):
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


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_bytes(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def merge_builder(fresh):
    """Add what is new, keep what we have — keyed by the STABLE recipe_id.

    `variant_meta[].id` (the variant id) and `published_recipe_uuid` are
    re-issued on EVERY `get_builder_data` call — two identical pulls share
    zero variant ids; only `recipe_id` is stable (ADR-0055, measured). A
    merge keyed by variant id therefore sees every existing recipe as "new"
    on the next sync and doubles the catalog. Keying by `recipe_id` keeps
    each committed entry (and its doc file name `<variantId>.json`, which
    the app resolves through builder_data) exactly as-is; genuinely new
    recipes — recipe_ids we have never shipped — join with their fresh ids.

    Existing entries are NOT overwritten: their popularity/rating snapshots
    are referenced by pinned e2e values and by the Auto-Plan golden packs,
    so a routine catalog sync must not silently move them. A deliberate
    refresh of those numbers is its own change.
    """
    with open(BUILDER_PATH) as f:
        cur = json.load(f)

    def rid_of(meta):
        rid = meta.get("recipe_id")
        if rid is None:
            raise ValueError("variant_meta entry without recipe_id: %r" % (meta.get("id"),))
        return int(rid)

    have_by_recipe = {rid_of(m): m for m in cur["variant_meta"]}
    have_meta = {m["id"]: m for m in cur["variant_meta"]}
    have_data = dict(cur["variant_data"])
    fresh_meta = {m["id"]: m for m in fresh["variant_meta"]}

    added, skipped_nonfeasible = [], 0
    feasible = set(fresh["feasible_variants"])
    for vid, meta in fresh_meta.items():
        if rid_of(meta) in have_by_recipe:
            # Known recipe under a re-issued id: keep OUR entry (its id is
            # what the committed docs, images and pins are named after).
            continue
        if vid in have_meta:
            continue
        if vid not in feasible:
            skipped_nonfeasible += 1
            continue
        have_by_recipe[rid_of(meta)] = meta
        have_meta[vid] = meta
        data = fresh["variant_data"].get(str(vid))
        if data is not None:
            have_data[str(vid)] = data
        added.append(vid)

    # Order: keep the existing sequence, then append newcomers sorted, so the
    # committed file stays diff-friendly.
    order = [v for v in cur["feasible_variants"] if v in have_meta]
    order += sorted(v for v in fresh["feasible_variants"] if v in have_meta and v not in set(order))

    cur["variant_meta"] = [have_meta[v] for v in order]
    cur["variant_data"] = {str(v): have_data[str(v)] for v in order if str(v) in have_data}
    cur["feasible_variants"] = order

    missing_docs = [v for v in order if not os.path.exists(os.path.join(DOC_DIR, "%d.json" % v))]
    return cur, added, skipped_nonfeasible, len(order), missing_docs


def sync_doc(vid, uuid, verify):
    """Archive + install one recipe doc. Returns a status string."""
    raw_path = os.path.join(RAW_DOC_DIR, "%d.json" % vid)
    app_path = os.path.join(DOC_DIR, "%d.json" % vid)

    need = not os.path.exists(app_path) or not os.path.exists(raw_path)
    if not need and not verify:
        return "kept"

    url = "%s/%s.json" % (CDN_ROOT, uuid)
    try:
        blob = fetch_json(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        return "error:%s" % e

    doc = json.loads(blob.decode())
    if doc.get("id") != vid:
        return "error:id-mismatch(%s)" % doc.get("id")

    with open(raw_path, "wb") as f:
        f.write(blob)
    with open(app_path, "wb") as f:
        f.write(blob)

    if not need:
        return "refreshed"
    return "added"


def encode_webp(jpeg_path, webp_path):
    from PIL import Image

    with Image.open(jpeg_path) as im:
        im = im.convert("RGB")
        im.save(webp_path, "WEBP", quality=82, method=4)


def sync_image(url):
    """Archive the jpeg, encode the webp. Returns a status string."""
    if not url:
        return "no-url"
    stem = url.split("/")[-1].rsplit(".", 1)[0]
    webp_path = os.path.join(IMG_DIR, stem + ".webp")
    if os.path.exists(webp_path) and os.path.exists(os.path.join(RAW_IMG_DIR, stem + ".jpeg")):
        return "kept"

    raw_path = os.path.join(RAW_IMG_DIR, stem + ".jpeg")
    if not os.path.exists(raw_path):
        try:
            with open(raw_path, "wb") as f:
                f.write(fetch_bytes(url))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return "error:%s" % e

    try:
        encode_webp(raw_path, webp_path)
    except Exception as e:  # a corrupt archive must not kill the sync
        return "error:webp(%s)" % e
    return "added"


def tally(results):
    out = {}
    for r in results:
        key = r.split(":")[0]
        out[key] = out.get(key, 0) + 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-file", default=os.path.join(MEDIA, ".mealime_token"))
    ap.add_argument("--builder-json", help="use a saved builder payload instead of the API")
    ap.add_argument("--verify", action="store_true", help="re-fetch every doc, write only images")
    ap.add_argument("--skip-images", action="store_true")
    args = ap.parse_args()

    for d in (DOC_DIR, IMG_DIR, RAW_DOC_DIR, RAW_IMG_DIR):
        os.makedirs(d, exist_ok=True)

    # 1. builder metadata ------------------------------------------------
    if args.builder_json:
        log("builder: reading %s" % args.builder_json)
        with open(args.builder_json) as f:
            fresh = json.load(f)
    else:
        token = read_token(args.token_file)
        if not token:
            log("ERROR: no token at %s — pass --token-file or --builder-json" % args.token_file)
            return 1
        log("builder: fetching (token from file, %d chars)" % len(token))
        fresh = fetch_builder(token)
    log("builder: payload has %d feasible variants" % len(fresh["feasible_variants"]))

    merged, added, skipped, total, missing_docs = merge_builder(fresh)
    log("builder: %d feasible after merge (+%d new, %d not feasible in payload)"
        % (total, len(added), skipped))
    if added:
        log("builder: new variant ids %s" % sorted(added))

    # 2. recipe docs ----------------------------------------------------
    uuid_of = {m["id"]: m.get("published_recipe_uuid") for m in merged["variant_meta"]}
    todo = missing_docs if not args.verify else list(uuid_of.keys())
    log("docs: %d to fetch (%d missing, verify=%s)" % (len(todo), len(missing_docs), args.verify))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(lambda v: sync_doc(v, uuid_of[v], args.verify), todo))
    log("docs: %s" % tally(results))
    errs = [r for r in results if r.startswith("error")]
    if errs:
        log("docs: %d errors, first: %s" % (len(errs), errs[0]))

    still_missing = [v for v in merged["feasible_variants"]
                     if not os.path.exists(os.path.join(DOC_DIR, "%d.json" % v))]
    if still_missing:
        log("docs: WARNING %d variants still have no doc: %s" % (len(still_missing), still_missing[:10]))

    # 3. images ---------------------------------------------------------
    if args.skip_images:
        log("images: skipped")
    else:
        urls = []
        for m in merged["variant_meta"]:
            urls.append(m.get("thumbnail_image_url"))
            urls.append(m.get("presentation_image_url"))
        urls = [u for u in urls if u]
        have = set(os.listdir(IMG_DIR))
        todo_img = [u for u in urls
                    if (u.split("/")[-1].rsplit(".", 1)[0] + ".webp") not in have]
        log("images: %d of %d to fetch" % (len(todo_img), len(urls)))
        if todo_img:
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                ires = list(pool.map(sync_image, todo_img))
            log("images: %s" % tally(ires))
            ierr = [r for r in ires if r.startswith("error")]
            if ierr:
                log("images: %d errors, first: %s" % (len(ierr), ierr[0]))

    # 4. write builder_data last (only once docs+images are in place) ----
    if not args.verify:
        with open(BUILDER_PATH, "w") as f:
            json.dump(merged, f)
        log("wrote %s (%d feasible)" % (os.path.relpath(BUILDER_PATH, ROOT), len(merged["feasible_variants"])))

    log("done — now run: python3 scripts/build_pack_index.py && "
        "python3 scripts/extract_ingredients.py")
    return 1 if errs else 0


if __name__ == "__main__":
    raise SystemExit(main())
