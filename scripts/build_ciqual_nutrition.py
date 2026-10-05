#!/usr/bin/env python3
"""Derive per-100 g nutrition for user-recipe ingredients from CIQUAL 2020.

ADR-0054, locked decision L5: a user recipe's `nutrition` block is COMPUTED
at build time from a European government food-composition table, never typed
by hand and never fitted against the frozen Mealime catalog.

Source
------
ANSES **CIQUAL**, release 2020-07-07, published open data (listed on
data.gouv.fr, downloads unauthenticated):

    https://ciqual.anses.fr/cms/sites/default/files/inline-files/XML_2020_07_07.zip

CIQUAL was chosen over USDA (not trusted by the owner) and over Fineli
(unreachable: Cloudflare blocks every path from the build machine, in curl AND
in a real browser, so a fetch that "sometimes works" cannot back a committed
artifact).

Two modes, and the split is deliberate: the DOWNLOAD is the owner's manual
step, the DERIVATION is offline and reproducible.

    python3 scripts/build_ciqual_nutrition.py --download   # owner only, needs network
    python3 scripts/build_ciqual_nutrition.py --source DIR # derive from an extracted copy
    python3 scripts/build_ciqual_nutrition.py --check      # CI-safe, OFFLINE: recompute
                                                           # every user recipe's nutrition
                                                           # from the COMMITTED table

Output: `public/data/ciqual_foods.json` — provenance + the audited food rows.
Every row is keyed by the SAME `nameKey` the grocery list uses (mirrored from
`src/lib/grocery.ts`; `bun run data:verify` gates the drift), so a recipe's
`line_items` resolve by that key with no per-recipe mapping.

The XML is NOT well-formed (a raw `<` inside an `ALIM_NOM_INDEX_FR` value,
"Panaché préemballé (<1° alc.)"), and `compo_2020_07_07.xml` is 57 MB, so
this is a tolerant block/tag scanner, never `xml.etree`.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATA_URL = (
    "https://ciqual.anses.fr/cms/sites/default/files/inline-files/XML_2020_07_07.zip"
)
RELEASE = "2020-07-07"
ZIP_NAME = f"XML_{RELEASE.replace('-', '_')}.zip"
PREFIX = f"{RELEASE.replace('-', '_')}"
FILES = {
    "alim": f"alim_{PREFIX}.xml",
    "compo": f"compo_{PREFIX}.xml",
    "const": f"const_{PREFIX}.xml",
    "alim_grp": f"alim_grp_{PREFIX}.xml",
}

OUT_PATH = os.path.join(REPO, "public", "data", "ciqual_foods.json")
USER_RECIPES = os.path.join(REPO, "public", "data", "user_recipes.json")

# Where `--download` caches the archive. Gitignored: it is 3.5 MB of upstream
# raw truth, reproducible from DATA_URL, and the DERIVED artifact is what the
# app ships. The committed table is reproducible offline from a cached copy.
CACHE_DIR = os.path.join(REPO, "scripts", ".ciqual")
# Where the extracted XMLs live when NOT using --download's cache: an env
# override for CI runners or a local checkout, defaulting to the cache dir.
XML_SOURCE_DIR = os.environ.get("CIQUAL_XML_DIR", CACHE_DIR)

# --------------------------------------------------------------------------
# nameKey — mirrored from src/lib/grocery.ts. `bun run data:verify` compares
# this implementation against the TypeScript one over the whole catalog.
# --------------------------------------------------------------------------


def name_key(name):
    """Mirror of `nameKey` in src/lib/grocery.ts."""
    s = name.strip().lower()
    if len(s) > 3 and s.endswith("oes"):
        return s[:-2]
    if len(s) > 4 and (
        s.endswith("ses")
        or s.endswith("xes")
        or s.endswith("zes")
        or s.endswith("ches")
        or s.endswith("shes")
    ):
        return s[:-2]
    if len(s) > 3 and s.endswith("s"):
        return s[:-1]
    return s


# --------------------------------------------------------------------------
# Atwater factors — the app's OWN published constants (src/lib/nutrition.ts):
# KCAL_PER_G = {fat: 9, carbs: 4, protein: 4} and KCAL_PER_G_FIBER_NET = 2.
# Reusing them keeps the derivation honest: CIQUAL's own grade-C energies ARE
# this computation (its "Energie, N x facteur Jones" rows), so re-deriving is
# faithful — but it is recorded as `energy_source: "atwater"`, never as if
# CIQUAL had published it.
# --------------------------------------------------------------------------

KCAL_PER_G = {"fat": 9.0, "carbs": 4.0, "protein": 4.0}
KCAL_PER_G_FIBER_NET = 2.0

# --------------------------------------------------------------------------
# Nutrient map: app `Nutrition` key -> CIQUAL const_code (EU Reg. 1169/2011
# basis). VERIFIED against const_2020_07_07.xml; the brief's table is wrong for
# sugars (32000, not 33000), starch (33110), fibre (34100) and saturated (40302).
#
# Keys CIQUAL does not publish at all (caffeine, transfats, choline and the 20
# amino acids) are absent from this table ON PURPOSE: a user recipe's block
# omits them rather than writing a fabricated 0.0. The app's facts modal
# projects the doc's own keys (`nutritionGroups` drops absent keys).
#
# Every unit CIQUAL publishes for these codes already matches the app's
# NUTRITION_UNITS (src/lib/nutrition.ts), so NO conversion factors are needed —
# which removes the usual per-mirror unit risk. `scripts/test_build_ciqual_nutrition.py`
# asserts that agreement by parsing NUTRITION_UNITS out of the TS.
# --------------------------------------------------------------------------

NUTRIENT_CODES = {
    "energy": 328,  # kcal/100 g
    "protein": 25000,  # g (Jones factor; 25003 is N x 6.25)
    "carbs": 31000,  # g
    "sugars": 32000,  # g
    "fructose": 32210,
    "galactose": 32220,
    "glucose": 32250,
    "lactose": 32410,
    "maltose": 32430,
    "sucrose": 32480,
    "starch": 33110,  # g
    "fiber": 34100,  # g
    "fat": 40000,  # g
    "monounsaturated": 40303,
    "polyunsaturated": 40304,
    "saturated": 40302,
    "omega_6": 41826,
    "omega_3": 41833,
    "sugar_alcohol": 34000,
    "water": 400,  # g
    "ash": 10000,  # g
    "alcohol": 60000,  # g
    "cholesterol": 75100,  # mg
    "vitamin_a": 51200,  # µg (retinol)
    "vitamin_d": 52100,  # µg
    "vitamin_e": 53100,  # mg
    # Vitamin K has no single CIQUAL row: phylloquinone (54101) + menaquinone
    # (54104), both µg. It is the one SUMMED nutrient.
    "vitamin_c": 55100,  # mg
    "b1_thiamine": 56100,  # mg
    "b2_riboflavin": 56200,  # mg
    "b3_niacin": 56310,  # mg
    "b5_pantothenic_acid": 56400,  # mg
    "b6_pyridoxine": 56500,  # mg
    "b12_cobalamin": 56600,  # µg
    "folate": 56700,  # µg
    # Minerals: CIQUAL publishes them in mg/100 g, which is exactly what the
    # app's NUTRITION_UNITS already claims for calcium/copper/iron/magnesium/
    # manganese/phosphorus/potassium/zinc — so no conversion factor is needed.
    "calcium": 10200,  # mg
    "copper": 10290,  # mg
    "iron": 10260,  # mg
    "magnesium": 10120,  # mg
    "manganese": 10251,  # mg
    "phosphorus": 10150,  # mg
    "potassium": 10190,  # mg
    "sodium": 10110,  # mg
    "zinc": 10300,  # g
    "selenium": 10340,  # µg
}

# SUGAR SUB-KEYS — the app's own sugar breakdown, which is what its
# `sugars` headline is the sum of. Verified against the frozen catalog: a doc
# with 2.31 g lactose reports `sugars` 20.94 against a sub-key sum of 20.09,
# i.e. the app's total sugars INCLUDE lactose.
SUGAR_PARTS = ("fructose", "galactose", "glucose", "lactose", "maltose", "sucrose")

# SUMMED nutrients: app key -> const codes, same unit.
SUMMED_CODES = {"vitamin_k": [54101, 54104]}

# Confidence grades CIQUAL publishes per composition row.
#   A = analysed / manufacturer data, B = calculated from a published
#   composition, C = CIQUAL's own Atwater computation, D = estimated or
#   borrowed from a similar food.
# A/B/C are published values and are ACCEPTED; D is refused (a documented
# "borrowed from a similar food" number is not a measurement of this food).
ACCEPTED_CONFIDENCE = ("A", "B", "C")
CONFIDENCE_RANK = {"A": 0, "B": 1, "C": 2, "D": 3}

# --------------------------------------------------------------------------
# The audited ingredient mapping — nameKey -> CIQUAL food.
#
# EXPLICIT AND REVIEWABLE BY DESIGN: every entry names an `alim_code` and
# records WHY that food was chosen, so a reviewer can audit a match instead of
# trusting a fuzzy one computed at build time with no record of what matched
# what. A documented choice is the deliverable; a silent wrong match is worse
# than a gap.
#
# CIQUAL publishes NO energy (`teneur = -`) for granulated sugar or for baking
# powder. Both are therefore derived by the Atwater rule above and marked
# `energy_source: "atwater"` in the artifact, so the provenance is visible.
# CIQUAL 9437 (self-raising flour, 350 kcal) was deliberately NOT substituted
# for the flour: it folds the leavening's own sodium (14 200 mg/100 g) into the
# flour and would double-count it against the separate baking-powder line.
# --------------------------------------------------------------------------

# Keys are nameKeys — the SAME strings the grocery list resolves a line item
# by — and they deliberately reuse the frozen catalog's display spelling
# (`all-purpose flour`, `butter, unsalted`, `whole milk`, …) so a household
# that already buys those staples sees ONE merged grocery line rather than two.
INGREDIENT_MAP = {
    "all-purpose flour": {
        "alim_code": "9435",
        "choice": (
            "Farine de blé tendre ou froment T65 — the plain wheat flour a "
            "batter asks for. NOT 9437 (farine avec levure incorporée), which "
            "would fold the leavening's sodium into the flour."
        ),
    },
    "lemon juice": {
        "alim_code": "2007",
        "choice": (
            "Jus de citron, maison — the acid in the buttermilk substitute. "
            "Home-made juice, not 2028 (pressed/pur jus) and not the pulp; "
            "40 ml of it is ~1 kcal per serving, honest noise."
        ),
    },
    "baking powder": {
        "alim_code": "11046",
        "choice": "Levure chimique / poudre à lever — the leavening itself, so its sodium is counted once.",
    },
    "salt": {
        "alim_code": "11017",
        "choice": "Sel blanc alimentaire non iodé non fluoré — plain sodium chloride (0 kcal, a REAL zero, not an absent value).",
    },
    "granulated sugar": {
        "alim_code": "31016",
        "choice": (
            "Sucre blanc — granulated sugar. CIQUAL publishes no energy row, so "
            "it is Atwater-derived."
        ),
        # CIQUAL grades this food's `sucres` and `saccharose` rows D (its
        # generic "estimated / from a similar food" grade) even though sucrose
        # is the whole food and 99.8 g/100 g is not an estimate. Refusing the
        # row would report 0 g sugar for a recipe with 50 g of it in it, which
        # is a worse lie than the grade. The exception is per-food, explicit,
        # and recorded in the artifact (`confidence` becomes "D"); the global
        # D refusal is untouched.
        "admit_confidence": ["D"],
        "admit_reason": (
            "CIQUAL grades sucrose's sugars rows D; sucrose is the food, so the "
            "grade is a database label rather than an estimate."
        ),
    },
    "egg": {
        "alim_code": "22000",
        "choice": "Oeuf, cru — whole raw egg. A recipe's count unit converts to grams (see UNIT_GRAMS).",
    },
    "whole milk": {
        "alim_code": "19024",
        "choice": (
            "Lait entier pasteurisé — whole milk. NOT 19023 (lait UHT): the "
            "figures are the same to CIQUAL's precision, and pasteurised is the "
            "default household carton."
        ),
    },
    "butter, unsalted": {
        "alim_code": "16400",
        "choice": "Beurre à 82% MG, doux — UNSALTED butter, matching the recipe (a salted butter would double-count the salt line).",
    },
    "vanilla extract": {
        "alim_code": "11065",
        "choice": "Vanille, extrait alcoolique — the alcohol-based vanilla extract the recipe calls for.",
    },
}

# Count units -> grams per count. CIQUAL is per 100 g, so a recipe's "3 large
# eggs" needs a documented weight. 50 g is the conventional large-egg weight;
# CIQUAL's own `Oeuf, cru` row is per 100 g of edible portion, so the whole-egg
# figure is used here rather than a shell-inclusive weight. The error across
# three eggs is a few grams — under 1% of the pancake's energy.
UNIT_GRAMS = {"egg": 50.0, "large egg": 50.0, "large eggs": 50.0}

# Liquid density for a volume->mass conversion, g/ml. Water-based liquids
# (milk, stock, juice) are 1.00 to within 0.5%; this is a documented
# approximation, not a measurement, and it is why a recipe's line items
# prefer grams.
LIQUID_DENSITY = {"ml": 1.0, "l": 1000.0, "cl": 10.0}


# --------------------------------------------------------------------------
# Tolerant XML scanning
# --------------------------------------------------------------------------

BLOCK_RE_CACHE = {}


def blocks(text, tag):
    """Every `<TAG> … </TAG>` block, whitespace-collapsed."""
    key = tag
    if key not in BLOCK_RE_CACHE:
        BLOCK_RE_CACHE[key] = re.compile(r"<%s>(.*?)</%s>" % (tag, tag), re.S)
    return BLOCK_RE_CACHE[key].findall(text)


TAG_RE_CACHE = {}


def field(block, tag):
    """One tag's text, or None.

    `<teneur missing=" " />` is how CIQUAL spells ABSENT — a self-closing tag
    carries no value and must never be read as an empty string or a zero.
    """
    if tag not in TAG_RE_CACHE:
        TAG_RE_CACHE[tag] = re.compile(
            r"<%s(?:\s[^>]*)?>(.*?)</%s>" % (tag, tag), re.S
        )
    m = TAG_RE_CACHE[tag].search(block)
    if not m:
        return None
    return m.group(1).strip()


def parse_teneur(raw):
    """A CIQUAL `teneur` into (value, flag).

    flag is 'value', 'limit' (a `<0,1` detection limit — the published bound is
    substituted and documented as an UPPER bound) or None when absent
    (`-`, or a self-closing tag). A real `0` is a REAL ZERO, not absence.
    """
    if raw is None:
        return None, None
    s = raw.strip()
    if not s or s == "-":
        return None, None
    flag = "value"
    if s.startswith("<"):
        s = s[1:]
        flag = "limit"
    # Comma decimals ("56,5") — never a thousands separator here.
    s = s.replace(",", ".")
    try:
        return float(s), flag
    except ValueError:
        return None, None


def read_xml(path):
    with open(path, "rb") as fh:
        return fh.read().decode("cp1252")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Derivation
# --------------------------------------------------------------------------


def nutrient_units(const_text):
    """const_code -> unit, parsed out of `const_nom_eng` (e.g. "(µg/100g)")."""
    units = {}
    for b in blocks(const_text, "CONST"):
        code = field(b, "const_code")
        eng = field(b, "const_nom_eng") or ""
        m = re.search(r"\((kcal|g|mg|µg)/100g\)\s*$", eng)
        if code and m:
            units[code] = m.group(1)
    return units


def nutrient_labels(const_text):
    labels = {}
    for b in blocks(const_text, "CONST"):
        code = field(b, "const_code")
        if code:
            labels[code] = {
                "fr": field(b, "const_nom_fr") or "",
                "en": field(b, "const_nom_eng") or "",
            }
    return labels


def food_names(alim_text):
    """alim_code -> (name_fr, name_en, group_code)."""
    out = {}
    for b in blocks(alim_text, "ALIM"):
        code = field(b, "alim_code")
        if not code:
            continue
        out[code] = (
            field(b, "alim_nom_fr") or "",
            field(b, "alim_nom_eng") or "",
            field(b, "alim_grp_code") or "",
        )
    return out


def compositions(compo_text, codes):
    """alim_code -> const_code -> (value, flag, confidence), for `codes` only.

    `codes` is a set of strings. CIQUAL stores composition per EDIBLE PORTION,
    which is exactly the basis a recipe line item needs.
    """
    wanted = set(codes)
    out = {}
    for b in blocks(compo_text, "COMPO"):
        code = field(b, "alim_code")
        if code not in wanted:
            continue
        const = field(b, "const_code")
        if const is None:
            continue
        value, flag = parse_teneur(field(b, "teneur"))
        conf = (field(b, "code_confiance") or "").strip() or None
        # Multiple rows per (food, nutrient) COULD occur as measurement
        # replicates (verified: the 2020 release has exactly one row per
        # (food, const) across all 211,898 — this is defensively future-proof,
        # not dead code today). Keep the FIRST row that carries a VALUE; a
        # later replicate must never overwrite a real number, and an earlier
        # trace/absent row must not hide one.
        out.setdefault(code, {})
        existing = out[code].get(const)
        if existing is None or (existing[0] is None and value is not None):
            out[code][const] = (value, flag, conf)
    return out


def derive_energy(per100):
    """Atwater energy, or None when the macros cannot support one."""
    fat = per100.get("fat")
    carbs = per100.get("carbs")
    protein = per100.get("protein")
    if fat is None or carbs is None or protein is None:
        return None
    fiber = per100.get("fiber") or 0.0
    fiber = min(max(fiber, 0.0), carbs)
    return (
        KCAL_PER_G["fat"] * fat
        + KCAL_PER_G["protein"] * protein
        + KCAL_PER_G["carbs"] * (carbs - fiber)
        + KCAL_PER_G_FIBER_NET * fiber
    )


def derive_sugars(per100):
    """Total sugars on the APP's basis, or None when CIQUAL supports no value.

    CIQUAL's `sucres` row (32000) EXCLUDES lactose and polyols — whole milk
    publishes no 32000 row at all, only 3.2 g of lactose — while the app's
    `sugars` is the sum of its six sugar sub-keys, lactose included (verified
    against the frozen catalog). Taking 32000 verbatim would therefore report
    sugar-free milk and understate the pancake's sugars by the lactose alone.

    So: CIQUAL's total plus the lactose it omits, or, when CIQUAL publishes no
    total (the milk case), the sum of whichever sub-keys it did publish. A food
    with neither is reported WITHOUT a `sugars` key rather than as 0.0.
    """
    total = per100.get("sugars")
    lactose = per100.get("lactose")
    if total is not None:
        return total + (lactose or 0.0)
    parts = [per100[k] for k in SUGAR_PARTS if per100.get(k) is not None]
    return sum(parts) if parts else None


def round2(v):
    return round(v + 0.0, 2)


def build_food(key, spec, names, comps, units):
    code = spec["alim_code"]
    # Per-food, explicitly reviewed exception to the D refusal (see
    # INGREDIENT_MAP's `admit_confidence`). Default: A/B/C only.
    accepted = set(ACCEPTED_CONFIDENCE) | set(spec.get("admit_confidence") or [])
    if code not in names:
        raise SystemExit(f"CIQUAL food {code} ({key}) is not in {FILES['alim']}")
    rows = comps.get(code)
    if not rows:
        raise SystemExit(f"CIQUAL food {code} ({key}) has no composition rows")
    name_fr, name_en, grp = names[code]

    per100 = {}
    flags = {}
    confs = []
    limits = []
    # '-' rows, by app key: the CONSTITUTION of the food, used by
    # `not_measured` below (a value ≠ an absence; both ≠ no row).
    dash_rows = set()
    for key_name, const in NUTRIENT_CODES.items():
        row = rows.get(str(const))
        if row is None:
            continue
        value, flag, conf = row
        if value is None:
            dash_rows.add(key_name)
            continue
        if conf and conf not in accepted:
            continue
        if conf:
            confs.append(conf)
        if flag == "limit":
            limits.append(key_name)
        per100[key_name] = value

    for key_name, consts in SUMMED_CODES.items():
        total = 0.0
        seen = False
        ok = True
        for const in consts:
            row = rows.get(str(const))
            if row is None or row[0] is None:
                ok = False
                break
            value, flag, conf = row
            if conf and conf not in accepted:
                ok = False
                break
            if conf:
                confs.append(conf)
            if flag == "limit":
                limits.append(key_name)
            total += value
            seen = True
        if ok and seen:
            per100[key_name] = total

    energy_source = "ciqual"
    if per100.get("energy") is None:
        derived = derive_energy(per100)
        if derived is None:
            raise SystemExit(
                f"CIQUAL food {code} ({key}) publishes neither an energy row nor the "
                "macros to derive one. Refusing to fabricate it."
            )
        per100["energy"] = derived
        energy_source = "atwater"

    sugars = derive_sugars(per100)
    sugars_derived = sugars is not None and per100.get("sugars") != sugars
    if sugars is None:
        per100.pop("sugars", None)
    else:
        per100["sugars"] = sugars
    # A DERIVED key is not a measured one: energy filled by Atwater (its
    # CIQUAL row is `-`) and sugars synthesized from sub-keys (whole milk)
    # must NOT also be listed in not_measured, or the artifact would call
    # the same number "published" and "not measured". (kody round 2, PR #49.)
    derived_keys = set()
    if energy_source == "atwater":
        derived_keys.add("energy")
    if sugars_derived:
        derived_keys.add("sugars")

    # The WORST grade among the rows that made it in, so a food whose macros
    # are calculated (C) never inherits the A of one analysed salt row.
    worst = max(confs, key=lambda c: CONFIDENCE_RANK.get(c, 9)) if confs else None
    return {
        "alim_code": code,
        "name_fr": name_fr,
        "name_en": name_en,
        "group_code": grp,
        "confidence": worst,
        "energy_source": energy_source,
        "choice": spec["choice"],
        "confidence_note": spec.get("admit_reason"),
        "below_limit": sorted(set(limits)),
        # A `-` row ("attempted, not measured") stays OUT of `per100g` — a
        # value it is not — but is recorded here so `recipe_nutrition` can
        # tell "CIQUAL tried and found nothing" (a real zero contribution)
        # apart from "no row at all" (the nutrient is UNKNOWN for this food,
        # so a total over it would be a partial sum published as complete).
        # The keys are the app's names, not const codes.
        "not_measured": [
            k for k in sorted(NUTRIENT_CODES)
            if k not in derived_keys
            and str(NUTRIENT_CODES[k]) in {str(c) for c in rows}
            and k in dash_rows
        ],
        "per100g": {k: round2(v) for k, v in sorted(per100.items())},
    }


def derive(source_dir):
    paths = {k: os.path.join(source_dir, v) for k, v in FILES.items()}
    for k, p in paths.items():
        if not os.path.exists(p):
            raise SystemExit(f"missing {FILES[k]} in {source_dir}")

    const_text = read_xml(paths["const"])
    units = nutrient_units(const_text)
    labels = nutrient_labels(const_text)

    # Fail loudly if the code map drifted from this CIQUAL release.
    for name, const in list(NUTRIENT_CODES.items()) + [
        (k, c) for k, cs in SUMMED_CODES.items() for c in cs
    ]:
        if str(const) not in labels:
            raise SystemExit(
                f"const_code {const} (mapped to `{name}`) is absent from "
                f"{FILES['const']} — the nutrient map needs re-verification."
            )

    names = food_names(read_xml(paths["alim"]))
    codes = {spec["alim_code"] for spec in INGREDIENT_MAP.values()}
    comps = compositions(read_xml(paths["compo"]), codes)

    foods = {}
    for key in sorted(INGREDIENT_MAP):
        foods[key] = build_food(key, INGREDIENT_MAP[key], names, comps, units)

    return {
        "provenance": {
            "dataset": "CIQUAL (ANSES)",
            "release": RELEASE,
            "url": DATA_URL,
            "license": "open data, published by ANSES (France), listed on data.gouv.fr",
            "basis": "per 100 g edible portion",
            "energy_kcal": "const_code 328 (Regulation EU No 1169/2011)",
            "energy_derivation": (
                "Atwater, the app's own factors (src/lib/nutrition.ts): 9 kcal/g "
                "fat + 4 kcal/g protein + 4 kcal/g digestible carbohydrate + 2 "
                "kcal/g net fibre. Used only where CIQUAL publishes no energy "
                "row, and recorded per food as energy_source=atwater."
            ),
            "confidence": {
                "accepted": list(ACCEPTED_CONFIDENCE),
                "refused": ["D"],
                "note": "A analysed, B calculated, C CIQUAL's own Atwater computation; D estimated or borrowed from a similar food is refused.",
            },
            "below_limit": "'<0,1' rows substitute the published LIMIT, so the emitted value is an upper bound.",
            "omitted": "Keys CIQUAL does not publish (caffeine, transfats, choline, the 20 amino acids) are ABSENT from every per100g block, never 0.0.",
            "sha256": {k: sha256(p) for k, p in sorted(paths.items())},
            "units": {str(c): units[str(c)] for c in sorted({*NUTRIENT_CODES.values(), *sum(SUMMED_CODES.values(), [])}) if str(c) in units},
            "nutrient_codes": {
                name: const for name, const in sorted(NUTRIENT_CODES.items())
            },
            "summed_nutrient_codes": {k: v for k, v in sorted(SUMMED_CODES.items())},
        },
        "unit": "per 100 g edible portion",
        "unitGrams": dict(sorted(UNIT_GRAMS.items())),
        "liquidDensity": dict(sorted(LIQUID_DENSITY.items())),
        "foods": foods,
    }


# --------------------------------------------------------------------------
# Recipe nutrition — the numbers that go into a user recipe's doc.
# --------------------------------------------------------------------------

FRACTIONS = {
    "½": 1 / 2,
    "¼": 1 / 4,
    "¾": 3 / 4,
    "⅓": 1 / 3,
    "⅔": 2 / 3,
    "⅛": 1 / 8,
    "⅜": 3 / 8,
    "⅝": 5 / 8,
    "⅞": 7 / 8,
}
FRACTION_CHARS = "".join(FRACTIONS)


def parse_quantity(raw):
    """Mirror of `parseQuantity` in src/lib/quantity.ts -> (amount, unit) or None.

    Mirrored so a user recipe's grams are derived from the SAME display string
    the grocery list and the cooking view read, instead of a second parser
    that could drift into a different number.
    """
    s = raw.strip()
    if not s:
        return None
    amount = 0.0
    matched = False
    m = re.match(r"^(\d+(?:[.,]\d+)?)", s)
    if m:
        amount = float(m.group(1).replace(",", "."))
        s = s[len(m.group(1)) :]
        matched = True
    s = s.lstrip()
    m = re.match(r"^(\d+)/(\d+)", s)
    if m:
        amount += int(m.group(1)) / int(m.group(2))
        s = s[m.end() :]
        matched = True
    else:
        m = re.match("^[%s]+" % FRACTION_CHARS, s)
        if m:
            for ch in m.group(0):
                amount += FRACTIONS[ch]
            s = s[m.end() :]
            matched = True
    if not matched:
        return None
    return amount, s.strip()


def line_item_grams(line_item, unit_grams, liquid_density):
    """Grams of one `line_items` entry, or None when it cannot be derived.

    NEVER guesses. A count unit with no documented weight, or an unknown unit,
    returns None so the caller refuses to publish a nutrition block rather than
    publishing one built on a guess.
    """
    parsed = parse_quantity(line_item.get("quantity") or "")
    if parsed is None:
        return None
    amount, unit = parsed
    u = unit.strip().lower()
    if u in ("", "g", "gram", "grams"):
        return amount
    if u in liquid_density:
        return amount * liquid_density[u]
    key = name_key(line_item.get("ingredient_name") or "")
    if u in unit_grams:
        return amount * unit_grams[u]
    if key in unit_grams:
        return amount * unit_grams[key]
    return None


def recipe_nutrition(doc, table):
    """Per-SERVING nutrition (ADR-0004) for a user recipe, from the table.

    Raises SystemExit naming the offending line item when a quantity cannot be
    converted to grams: an incomplete nutrition block is not an acceptable
    fallback (locked L5).

    COVERAGE RULE: a nutrition key is published only when EVERY contributing
    food publishes it (`per100g`). CIQUAL marks an unmeasured nutrient `-`
    (flour T65 has no measured starch row), and summing only the foods that
    DO publish would emit a partial total — a 0.12 g starch next to 43.87 g
    of carbs — as if it were complete. A key any contributor fails to
    publish is OMITTED from the block, the same honesty the artifact's own
    `omitted` provenance rule already applies to never-measured nutrients.
    The headline numbers (energy, protein, carbs, fat, sodium) survive the
    rule for any recipe whose foods carry the CIQUAL frame, derived energy
    and derived sugars included.
    """
    foods = table["foods"]
    unit_grams = table.get("unitGrams", {})
    liquid_density = table.get("liquidDensity", {})
    contributions = []  # (ingredient key, grams, per100g block)
    if not (doc.get("line_items") or []):
        # A doc with no line items has nothing to total: an EMPTY block is the
        # honest output (check() runs this over every committed recipe, so a
        # raise here would fail the whole data gate on one degenerate entry).
        return {}
    for line in doc.get("line_items") or []:
        grams = line_item_grams(line, unit_grams, liquid_density)
        if grams is None:
            raise SystemExit(
                "cannot convert %r (%s) to grams — add a documented weight to "
                "unitGrams, or express the line item in grams"
                % (line.get("quantity"), line.get("ingredient_name"))
            )
        key = name_key(line.get("ingredient_name") or "")
        food = foods.get(key)
        if food is None:
            raise SystemExit(
                "no CIQUAL row for ingredient `%s` — add it to INGREDIENT_MAP "
                "and re-run the generator" % key
            )
        contributions.append((key, grams, food["per100g"]))

    # The keys with FULL coverage; everything else is unknown, never assumed.
    coverage = set(contributions[0][2])
    for _key, _grams, per100 in contributions[1:]:
        coverage &= set(per100)

    totals = {}
    for _key, grams, per100 in contributions:
        for nutrient in coverage:
            totals[nutrient] = totals.get(nutrient, 0.0) + per100[nutrient] * grams / 100.0

    servings = doc["serving_count"]
    if not servings:
        raise SystemExit("recipe has no serving_count; nutrition cannot be per serving")
    return {k: round2(v / servings) for k, v in sorted(totals.items())}


def load_table():
    with open(OUT_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def check():
    """OFFLINE gate: recompute every user recipe from the COMMITTED table."""
    table = load_table()
    with open(USER_RECIPES, encoding="utf-8") as fh:
        payload = json.load(fh)
    problems = 0
    for entry in payload.get("recipes", []):
        doc = entry["doc"]
        expected = recipe_nutrition(doc, table)
        actual = doc.get("nutrition") or {}
        drift = {
            k: (round2(expected.get(k, 0.0)), actual.get(k))
            for k in set(expected) | set(actual)
            if abs(expected.get(k, 0.0) - actual.get(k, 0.0)) > 0.01
        }
        meta = entry.get("meta") or {}
        head = []
        if abs(meta.get("calories", -1) - expected.get("energy", 0.0)) > 0.5:
            head.append(
                "meta.calories %s != derived energy %s" % (meta.get("calories"), expected.get("energy"))
            )
        if abs(meta.get("sodium_mg", -1) - expected.get("sodium", 0.0)) > 0.5:
            head.append(
                "meta.sodium_mg %s != derived sodium %s" % (meta.get("sodium_mg"), expected.get("sodium"))
            )
        # The card's macros line comes from the SAME derived block, so the
        # offline gate must pin it too — as CALORIE FRACTIONS (the catalog's
        # own builder_data convention, e.g. fats 0.54 on a 759 kcal dish;
        # the card plots the fraction directly). Recompute the fraction from
        # the derived grams with the same kcal/g the authoring script uses,
        # so a changed line item can no longer pass with stale card macros.
        macro_drift = []
        macros = meta.get("macros") or {}
        kcal_per_macro = {"fats": 9.0, "carbs": 4.0, "protein": 4.0}
        derived_grams = {
            "fats": expected.get("fat"),
            "carbs": expected.get("carbs"),
            "protein": expected.get("protein"),
        }
        if any(v is None for v in derived_grams.values()):
            macro_drift.append("derived block lacks the macros kcal needs")
        else:
            g_fats, g_carbs, g_protein = (
                derived_grams["fats"], derived_grams["carbs"], derived_grams["protein"]
            )
            assert g_fats is not None and g_carbs is not None and g_protein is not None
            kcal_total = (
                g_fats * kcal_per_macro["fats"]
                + g_carbs * kcal_per_macro["carbs"]
                + g_protein * kcal_per_macro["protein"]
            )
            if kcal_total <= 0:
                macro_drift.append("macros kcal total is %s; cannot verify fractions" % kcal_total)
            else:
                for key, grams in (
                    ("fats", g_fats), ("carbs", g_carbs), ("protein", g_protein)
                ):
                    want = grams * kcal_per_macro[key] / kcal_total
                    got = macros.get(key)
                    if got is None or abs(got - want) > 0.01:
                        macro_drift.append(
                            "meta.macros.%s %s != derived fraction %.4f" % (key, got, want)
                        )
        head.extend(macro_drift)
        if drift or head:
            problems += 1
            print("DRIFT %s (%s)" % (doc.get("name"), doc.get("id")))
            for k, (e, a) in sorted(drift.items()):
                print("   %-18s derived %s, committed %s" % (k, e, a))
            for line in head:
                print("   " + line)
        else:
            print("ok %s — %s derived keys, %.1f kcal/serving" % (doc.get("name"), len(expected), expected["energy"]))
    if problems:
        print("\n%d user recipe(s) drifted from the committed CIQUAL table." % problems)
        return 1
    print("\nall user recipes match the committed CIQUAL table")
    return 0


def download(dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    zip_path = os.path.join(dest_dir, ZIP_NAME)
    if os.path.exists(zip_path):
        print("already cached: %s" % zip_path)
        return zip_path
    print("downloading %s" % DATA_URL)
    with urllib.request.urlopen(DATA_URL, timeout=120) as resp:
        data = resp.read()
    with open(zip_path, "wb") as fh:
        fh.write(data)
    print("wrote %s (%d bytes)" % (zip_path, len(data)))
    return zip_path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--download", action="store_true", help="fetch + cache the CIQUAL zip (needs network)")
    ap.add_argument("--source", help="directory holding the extracted CIQUAL XML files")
    ap.add_argument("--check", action="store_true", help="offline: verify user recipes against the committed table")
    args = ap.parse_args(argv)

    if args.check:
        return check()

    source = args.source or XML_SOURCE_DIR
    if args.download:
        zip_path = download(CACHE_DIR)
        source = source or CACHE_DIR
        if not os.path.exists(os.path.join(source, FILES["compo"])):
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(source)
    if not source:
        source = CACHE_DIR
    if not os.path.exists(os.path.join(source, FILES["compo"])):
        print(
            "No CIQUAL XML in %s.\n"
            "Run once with network access:\n"
            "  python3 scripts/build_ciqual_nutrition.py --download\n"
            "then re-run offline with --source %s" % (source, source),
            file=sys.stderr,
        )
        return 2

    table = derive(source)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(table, fh, indent=1, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    print("wrote %s (%d foods)" % (OUT_PATH, len(table["foods"])))
    for key, food in table["foods"].items():
        print(
            "  %-14s %-6s %-4s energy %6s kcal (%s) %d keys"
            % (
                key,
                food["alim_code"],
                food["confidence"],
                food["per100g"].get("energy"),
                food["energy_source"],
                len(food["per100g"]),
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
