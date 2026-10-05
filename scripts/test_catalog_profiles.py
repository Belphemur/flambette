#!/usr/bin/env python3
"""Golden: the ADR-0054 profile archive, and what it proves about our converter.

This suite has two jobs, and the second is why it exists at all.

1. **The archive is well-formed.** Every archived doc belongs to the profile it
   sits in, carries the profile's `units`/`serving_count`, and the two profiles
   agree on the recipe set. Stdlib unittest, no network: it reads
   `../mealime-media/raw_profiles/` as it sits on disk.

2. **The archive is a TEST FIXTURE for ADR-0047.** The imperial profile is
   upstream's own imperial wording for recipes we already hold in metric. That
   makes it ground truth for the display-time conversion: this file reports the
   measured agreement rate so the number in the ADR cannot silently rot, and it
   FAILS on the specific converter bug the diff found (`mm` missing from the
   length table, so `6-mm pieces` never becomes `¼-inch pieces`).

A golden must never need the network. If the archive is absent the conversion
job SKIPS (with a message) rather than passing vacuously; the archive is
gitignored, so a fresh clone legitimately has none. Point `--archive` at
another directory to test a copy.
"""

import argparse
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_ARCHIVE = os.path.join(os.path.dirname(ROOT), "mealime-media", "raw_profiles")

# The bug this fixture exists to catch. ADR-0047's LENGTH_RE alternation is
# `cm|inch(?:es)?`; the corpus also spells millimetres, and only in the
# hyphenated form (166 occurrences across 120 docs, 0 bare `mm`).
MM_LENGTH_RE = re.compile(r"(\d+(?:[.,]\d+)?)[ \t]*-[ \t]*mm(?![a-z])")

# Floor for the ADR-0047 vs upstream agreement rate, measured over the FULL
# corpus (2 759 docs, 187 unique differing pairs). ADR-0054's converter change
# (the measured quantization grids + fraction glyphs + can-size table + the
# keep-ml carve-out) raised the rate from 124/187 = 66.3% to 156/187 = 83.4%;
# the pin below is the NEW measured figure (floor 0.83). The rate is a
# REGRESSION floor, not an equality — display-time conversion is *allowed* to
# differ from upstream's authored strings, because a package label (`398 ml`
# -> `15 oz`) is a product fact no conversion can derive and noun inflection
# (`pkg` -> `pkgs`) is upstream's pluralisation. The remaining 31-pair residue
# is upstream re-authoring noise (pkg/pkgs flips, berry pints, odd can
# labels) — see ADR-0054's residue section.
MIN_AGREEMENT = 0.83

# The count of instruction steps whose N-mm length the converter leaves
# unconverted, measured over the archived imperial profile. ADR-0047 shipped
# with the gap OPEN (166 of 166 unconverted); ADR-0054's converter change
# added `mm` to LENGTH_RE with fraction-aware output (`6-mm` -> `¼-inch`) and
# the pin is now 0. Any nonzero value means the prose pass regressed, which is
# exactly what the assertion is for.
KNOWN_MM_GAP = 0


def load_index(archive):
    path = os.path.join(archive, "index.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def profile_docs(archive, label, limit=None):
    """Archived docs for a profile, as (recipe_id, doc) pairs."""
    d = os.path.join(archive, label, "recipes")
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(d, name)) as f:
            out.append((name[:-5], json.load(f)))
        if limit and len(out) >= limit:
            break
    return out


class ArchiveShapeTest(unittest.TestCase):
    """Job 1: the archive is internally consistent."""

    @classmethod
    def setUpClass(cls):
        cls.archive = DEFAULT_ARCHIVE
        cls.index = load_index(cls.archive)
        if cls.index is None:
            return
        cls.profiles = cls.index["profiles"]

    def setUp(self):
        if self.index is None:
            self.skipTest("no profile archive at %s (gitignored; archive one to run this)"
                          % self.archive)

    def test_index_lists_the_profiles_we_archived(self):
        """All six renders of the 2x3 matrix (ADR-0054: 2 unit systems x
        serving counts 2/4/6, reachable via set_profile)."""
        for label in ("metric-2", "metric-4", "metric-6", "us-2", "us-4", "us-6"):
            self.assertIn(label, self.profiles,
                          "profile %s missing from the index" % label)

    def test_units_are_measured_not_labelled(self):
        """`units` must be read off a doc. 'US' is the value that proves it."""
        for label in ("metric-2", "metric-4", "metric-6"):
            self.assertEqual(self.profiles[label]["units"], "Metric")
        for label in ("us-2", "us-4", "us-6"):
            self.assertEqual(self.profiles[label]["units"], "US")

    def test_serving_counts_are_catalog_uniform(self):
        """One setting per pull: the count is uniform across each profile."""
        self.assertEqual(self.profiles["metric-2"]["serving_count"], [2])
        self.assertEqual(self.profiles["metric-4"]["serving_count"], [4])
        self.assertEqual(self.profiles["metric-6"]["serving_count"], [6])
        self.assertEqual(self.profiles["us-2"]["serving_count"], [2])
        self.assertEqual(self.profiles["us-4"]["serving_count"], [4])
        self.assertEqual(self.profiles["us-6"]["serving_count"], [6])

    def test_recipe_ids_are_the_stable_identity(self):
        """Both profiles must cover the same recipes — the thing ids cannot do.

        metric-4 may be a strict SUPERSET: it was pulled later and carries one
        recipe (recipe_id 679) the other two pulls do not have. That is the
        catalog growing, not an identity failure, so the assertion is
        containment in the documented direction plus an explicit allowance.
        """
        a = set(self.profiles["us-6"]["recipe_id_to_uuid"])
        b = set(self.profiles["metric-4"]["recipe_id_to_uuid"])
        self.assertEqual(a - b, set(), "us-6 has recipes metric-4 lacks")
        extra = b - a
        if extra:
            sys.stderr.write(
                "  note: metric-4 carries %d recipe(s) absent from us-6 "
                "(catalog grew between pulls): %s\n"
                % (len(extra), sorted(extra, key=int)))
        self.assertLessEqual(len(extra), 5,
                             "metric-4 gained %d recipes over us-6 — that is not "
                             "catalog growth, re-check the archive" % len(extra))

    def test_variant_ids_are_not_stable_across_profiles(self):
        """The finding that breaks id-keyed syncs, asserted so it stays true.

        Two profiles of the same catalog expose DIFFERENT variant ids. If this
        ever starts failing, upstream stabilised ids and `merge_builder()`'s
        id-keyed merge became safe — revisit ADR-0054 then, not before.
        """
        payloads = {}
        for label in ("us-6", "metric-4"):
            with open(os.path.join(self.archive, label, "builder_data.json")) as f:
                payloads[label] = json.load(f)
        ida = {m["id"] for m in payloads["us-6"]["variant_meta"]}
        idb = {m["id"] for m in payloads["metric-4"]["variant_meta"]}
        self.assertEqual(ida & idb, set(),
                         "variant ids now overlap across profiles; ADR-0054's "
                         "identity finding needs revisiting")

    def test_every_archived_doc_matches_its_profile(self):
        """A doc's units/serving_count must equal the profile it was filed under."""
        for label, units, sv in (("us-6", "US", 6), ("metric-4", "Metric", 4)):
            docs = profile_docs(self.archive, label, limit=120)
            self.assertTrue(docs, "no docs archived for %s" % label)
            for _uuid, doc in docs:
                self.assertEqual(doc["units"], units,
                                 "%s doc has units=%r" % (label, doc["units"]))
                self.assertEqual(doc["serving_count"], sv,
                                 "%s doc has serving_count=%r" % (label, doc["serving_count"]))

    def test_archive_is_outside_the_repo(self):
        """Raw truth stays out of git; only the script is committed."""
        self.assertFalse(self.archive.startswith(os.path.join(ROOT, "public")),
                         "raw profiles must never land under public/")


class ConversionParityTest(unittest.TestCase):
    """Job 2: the imperial profile as ground truth for ADR-0047.

    Reads the COMMITTED metric docs and the ARCHIVED imperial ones, joins them
    on `recipe_id`, and measures how much of upstream's imperial wording our
    display-time conversion reproduces. Skipped without an archive.
    """

    @classmethod
    def setUpClass(cls):
        cls.archive = DEFAULT_ARCHIVE
        cls.mm_cases = []
        if load_index(cls.archive) is None:
            return
        committed = {}
        docs_dir = os.path.join(ROOT, "public", "data", "recipes")
        for name in sorted(os.listdir(docs_dir)):
            if not re.fullmatch(r"\d+\.json", name):
                continue  # skip the ADR-0041 timer sidecars
            with open(os.path.join(docs_dir, name)) as f:
                d = json.load(f)
            committed[d["recipe_id"]] = d
        cls.pairs = []
        cls.mm_cases = []
        for _uuid, us in profile_docs(cls.archive, "us-6"):
            metric = committed.get(us["recipe_id"])
            if not metric or metric.get("units") != "Metric":
                continue
            for m_line, us_line in zip(metric["line_items"], us["line_items"]):
                if m_line["quantity"] != us_line["quantity"]:
                    cls.pairs.append((m_line["quantity"], us_line["quantity"]))
            for m_step, us_step in zip(metric["instructions"], us["instructions"]):
                t = m_step.get("primary_message", "")
                if MM_LENGTH_RE.search(t):
                    cls.mm_cases.append((t, us_step.get("primary_message", "")))
        cls.unique_pairs = sorted(set(cls.pairs))

    def setUp(self):
        if load_index(self.archive) is None:
            self.skipTest("no profile archive at %s" % self.archive)

    def _convert(self):
        """Run the app's converter over the pairs via a tiny bun harness."""
        import subprocess
        harness = os.path.join(HERE, "_parity_harness.ts")
        payload = os.path.join(HERE, "_parity_pairs.json")
        with open(payload, "w") as f:
            json.dump(self.unique_pairs, f)
        with open(harness, "w") as f:
            f.write(
                "import { localizeQuantity } from '../src/lib/units'\n"
                "const pairs = await Bun.file('%s').json()\n"
                "const out = pairs.map(([m]: [string, string]) =>\n"
                "  [m, localizeQuantity(m, 'imperial') as string] as [string, string])\n"
                "console.log(JSON.stringify(out))\n" % payload
            )
        try:
            r = subprocess.run(["bun", "run", harness], cwd=ROOT,
                               capture_output=True, text=True, timeout=180)
        except FileNotFoundError:
            self.skipTest("bun not on PATH")
        finally:
            for p in (harness, payload):
                if os.path.exists(p):
                    os.remove(p)
        if r.returncode != 0:
            self.fail("converter harness failed: %s" % r.stderr[-800:])
        return {m: got for m, got in json.loads(r.stdout.strip().splitlines()[-1])}

    def test_conversion_agreement_has_not_regressed(self):
        """Floor at the measured full-corpus rate, 156/187 = 83.4% (ADR-0054).

        The 0.73 in ADR-0054 came from a 300-recipe sample; the full corpus
        measures lower because the imperial render's own rounding is noisier
        than the sample suggested. Divergence is legitimate (see
        MIN_AGREEMENT), so this catches REGRESSION, not disagreement.
        """
        converted = self._convert()
        hits = sum(1 for _m, us in self.unique_pairs if converted.get(_m) == us)
        rate = hits / len(self.unique_pairs) if self.unique_pairs else 0.0
        sys.stderr.write(
            "\n  ADR-0047 vs upstream imperial render: %d/%d exact (%.0f%%) over %d unique pairs\n"
            % (hits, len(self.unique_pairs), 100 * rate, len(self.unique_pairs)))
        self.assertGreaterEqual(rate, MIN_AGREEMENT,
                                "imperial conversion agreement fell below %.0f%%" % (MIN_AGREEMENT * 100))

    def test_millimetre_lengths_were_a_known_gap(self):
        """The CLOSED converter gap: `N-mm` must never reach imperial untouched.

        Millimetres appear ONLY in instruction PROSE, never in a line-item
        quantity (corpus census: 166 hyphenated occurrences across 120 docs, 0
        bare `mm`, 0 in quantities), so this reads the instruction text of the
        archived imperial docs and checks the converter directly.

        ADR-0047 shipped with the gap OPEN (166 unconverted) and this was a
        known-gap pin. ADR-0054's converter change closed it — `mm` joined the
        LENGTH_RE alternation and the output went fraction-aware (`6-mm` ->
        `¼-inch`, the ⅛ ladder, separator preserved) — so the pin is now 0 and
        the assertion is a REGRESSION gate: any unconverted N-mm step fails.
        """
        cases = self._mm_prose_cases()
        if not cases:
            self.skipTest("no N-mm prose in the archived imperial docs")
        converted = self._convert_texts(sorted({c for c, _ in cases}))
        unconverted = [c for c, _u in cases if converted.get(c) == c]
        sys.stderr.write(
            "\n  N-mm prose: %d/%d still unconverted "
            "(upstream renders them as inches)\n"
            % (len(unconverted), len(cases)))
        self.assertEqual(
            len(unconverted), KNOWN_MM_GAP,
            "the N-mm gap is %d, expected %d. If it grew, a converter change "
            "regressed the prose pass (LENGTH_RE or localizeLengths in "
            "src/lib/units.ts)."
            % (len(unconverted), KNOWN_MM_GAP))

    def _mm_prose_cases(self):
        """(metric_step, us_step) pairs where the metric step holds an N-mm."""
        if self.mm_cases is None:
            return []
        return self.mm_cases

    def _convert_texts(self, texts):
        import subprocess
        harness = os.path.join(HERE, "_parity_harness_text.ts")
        payload = os.path.join(HERE, "_parity_texts.json")
        with open(payload, "w") as f:
            json.dump(texts, f)
        with open(harness, "w") as f:
            f.write(
                "import { localizeText } from '../src/lib/units'\n"
                "const texts = await Bun.file('%s').json()\n"
                "const out = texts.map((t: string) => [t, localizeText(t, 'imperial')] as [string, string])\n"
                "console.log(JSON.stringify(out))\n" % payload
            )
        try:
            r = subprocess.run(["bun", "run", harness], cwd=ROOT,
                               capture_output=True, text=True, timeout=180)
        except FileNotFoundError:
            self.skipTest("bun not on PATH")
        finally:
            for p in (harness, payload):
                if os.path.exists(p):
                    os.remove(p)
        if r.returncode != 0:
            self.fail("text harness failed: %s" % r.stderr[-800:])
        return {t: got for t, got in json.loads(r.stdout.strip().splitlines()[-1])}


def main():
    global DEFAULT_ARCHIVE
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=DEFAULT_ARCHIVE,
                    help="raw_profiles directory (default: ../mealime-media/raw_profiles)")
    args = ap.parse_args()
    DEFAULT_ARCHIVE = args.archive
    unittest.main(argv=[sys.argv[0], "-v"])


if __name__ == "__main__":
    main()