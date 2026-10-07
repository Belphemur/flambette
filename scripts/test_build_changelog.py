#!/usr/bin/env python3
"""Golden tests for scripts/build_changelog.py (ADR-0060).

The committed public/data/changelog.json is a build-time derivation, so the
invariants behind it need a gate too — a hand-authored table that shadows
the git history is invisible to bun test. These goldens assert the PARSER
(extracting feat/fix, scope, PR, ADR, excluding chore, skipping merges),
the TITLE policy (grandfathered authored table > derived-from-commits,
which is now the default for new tags), the STALE --check behaviour, and
the artifact shape.

    python3 scripts/test_build_changelog.py

Joins `bun run test:data` alongside the other generator goldens.
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "data", "changelog.json")

# Load the generator as a module so we can call build() directly (no subprocess
# stdout pollution).
_spec = importlib.util.spec_from_file_location("build_changelog", os.path.join(HERE, "build_changelog.py"))
_build_changelog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_build_changelog)
build = _build_changelog.build
GOLDEN_TAG = _build_changelog.GOLDEN_TAG
GOLDEN_TITLE = _build_changelog.GOLDEN_TITLE


class ChangelogGoldens(unittest.TestCase):
    """Goldens for scripts/build_changelog.py (ADR-0060)."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(OUT):
            raise AssertionError("%s missing — run `python3 scripts/build_changelog.py`" % OUT)
        with open(OUT) as f:
            cls.doc = json.load(f)
        cls.fresh = build()

    # ── Parser goldens ───────────────────────────────────────────────────

    def test_versions_are_newest_first(self):
        """Versions are sorted newest first (highest semver tag first)."""
        versions = self.doc["versions"]
        self.assertTrue(len(versions) > 0, "at least one version must be emitted")
        all_tags = [v["version"] for v in versions]
        semver = lambda t: tuple(int(x) for x in re.match(r"v(\d+)\.(\d+)\.(\d+)", t).groups())
        expected = sorted(all_tags, key=semver, reverse=True)
        self.assertEqual(all_tags, expected)

    def test_feat_and_fix_split(self):
        """Every version partitions entries into features and fixes; no entry
        appears in both, and no excluded type leaked through."""
        for v in self.doc["versions"]:
            feat_texts = {e["text"] for e in v.get("features", [])}
            fix_texts = {e["text"] for e in v.get("fixes", [])}
            self.assertTrue(
                feat_texts.isdisjoint(fix_texts),
                "%s: overlap between features and fixes" % v["version"],
            )
            # Features may carry ADR references (they are the design records
            # that motivated the change); fixes may carry PRs.
            for e in v.get("features", []):
                self.assertIn(e.get("pr"), (None, *range(1, 999999)))
                if e.get("adr"):
                    self.assertRegex(e["adr"], r"^ADR-\d+$")
            for e in v.get("fixes", []):
                self.assertIn(e.get("pr"), (None, *range(1, 999999)))

    def test_chore_is_excluded(self):
        """No chore, docs, refactor, test, ci, or build entry anywhere."""
        for v in self.doc["versions"]:
            for bucket in ("features", "fixes"):
                for e in v.get(bucket, []):
                    self.assertNotIn("chore", e["text"].lower())

    def test_merges_are_skipped(self):
        """No merge commit subject appears in any bucket."""
        for v in self.doc["versions"]:
            for bucket in ("features", "fixes"):
                for e in v.get(bucket, []):
                    self.assertFalse(
                        e["text"].startswith("Merge"),
                        "merge leaked into %s/%s: %s" % (v["version"], bucket, e["text"]),
                    )
                    self.assertFalse(
                        e["text"].startswith("Merge pull request"),
                        "merge leaked into %s/%s: %s" % (v["version"], bucket, e["text"]),
                    )

    def test_scope_pr_adr_extraction(self):
        """Scope, PR, and ADR are extracted into separate fields and stripped
        from the human-readable text."""
        for v in self.doc["versions"]:
            for e in v.get("features", []):
                if e["adr"]:
                    self.assertNotIn("(%s)" % e["adr"], e["text"])
                if e["pr"]:
                    self.assertNotIn("(#%d)" % e["pr"], e["text"])
            for e in v.get("fixes", []):
                if e["adr"]:
                    self.assertNotIn("(%s)" % e["adr"], e["text"])
                if e["pr"]:
                    self.assertNotIn("(#%d)" % e["pr"], e["text"])

    # ── Title goldens ─────────────────────────────────────────────────────

    def test_v2_2_0_title_is_authored(self):
        """v2.2.0 must carry the authored title, not a derived one."""
        v = next((x for x in self.doc["versions"] if x["version"] == GOLDEN_TAG), None)
        self.assertIsNotNone(v, "%s not in changelog" % GOLDEN_TAG)
        self.assertEqual(
            v["title"], GOLDEN_TITLE,
            "%s title should be authored '%s', got '%s'" % (GOLDEN_TAG, GOLDEN_TITLE, v["title"]),
        )

    def test_v2_2_0_feature_is_extracted(self):
        """v2.2.0's leading feat surfaces with scope + PR + ADR."""
        v = next((x for x in self.doc["versions"] if x["version"] == GOLDEN_TAG), None)
        self.assertIsNotNone(v)
        features = v.get("features", [])
        self.assertTrue(len(features) > 0, "%s: no features extracted" % GOLDEN_TAG)
        fav = next(
            (e for e in features if "favourites" in e.get("scope", "") or "favourites" in e["text"]),
            None,
        )
        self.assertIsNotNone(fav, "%s: favourites feature not found in %s" % (GOLDEN_TAG, features))
        self.assertEqual(fav["scope"], "favourites")
        self.assertEqual(fav["pr"], 53, "PR ref not extracted for %s" % GOLDEN_TAG)
        self.assertEqual(fav["adr"], "ADR-0058", "ADR ref not extracted for %s" % GOLDEN_TAG)
        self.assertNotIn("(ADR-0058)", fav["text"], "ADR ref should be stripped from text")
        self.assertNotIn("(#53)", fav["text"], "PR ref should be stripped from text")

    def test_title_precedence_authored_over_derived(self):
        """Every version's title is either explicitly authored (in the
        generator's grandfathered table) or derived from its first feat/fix
        — never empty, never a version number. The 'looks like a commit
        subject' check applies to AUTHORED entries only: a derived title is
        a feat subject by design and may legitimately contain ': '."""
        for v in self.doc["versions"]:
            self.assertTrue(len(v["title"]) > 3,
                            "%s: title too short: '%s'" % (v["version"], v["title"]))
            if v["version"] in _build_changelog.AUTHORED_TITLES:
                self.assertEqual(v["title"], _build_changelog.AUTHORED_TITLES[v["version"]],
                                 "%s: authored title drifted from the table" % v["version"])
                self.assertFalse(v["title"].startswith("v"),
                                 "%s: authored title must not contain a version number: '%s'" % (v["version"], v["title"]))
                self.assertFalse(": " in v["title"],
                                 "%s: authored title must not look like a raw commit subject: '%s'" % (v["version"], v["title"]))

    # ── Structural goldens ────────────────────────────────────────────────

    def test_all_tags_present(self):
        """Every v* tag in the repo has an entry (prepopulated, ADR-0060 §3)."""
        tags_raw = subprocess.check_output(["git", "tag", "-l", "v*"], encoding="utf8").split()
        missing = sorted(set(tags_raw) - {v["version"] for v in self.doc["versions"]})
        self.assertEqual(missing, [], "missing versions: %s" % missing)

    def test_fallback_title_derivation(self):
        """An unlisted version gets a derived title (first feat > first fix >
        'Maintenance release'), never an empty one."""
        for v in self.doc["versions"]:
            self.assertTrue(len(v["title"]) > 3,
                            "%s: title too short: '%s'" % (v["version"], v["title"]))

    def test_artifact_shape(self):
        """The artifact matches the ADR-0060 §4 schema."""
        self.assertIn("generatedAt", self.doc)
        self.assertIn("versions", self.doc)
        for v in self.doc["versions"]:
            self.assertIn("version", v)
            self.assertIn("date", v)
            self.assertIn("title", v)
            for bucket in ("features", "fixes"):
                if bucket in v:
                    self.assertIsInstance(v[bucket], list)
                    for e in v[bucket]:
                        self.assertIn("text", e)
                        self.assertIn("scope", e)
                        self.assertIn("pr", e)
                        self.assertIn("adr", e)

    def test_idempotent_modulo_generated_at(self):
        """Re-running produces identical output except for generatedAt."""
        fresh = build()
        committed = self.doc
        for k in ("generatedAt",):
            committed.pop(k, None)
            fresh.pop(k, None)
        self.assertEqual(fresh, committed)

    # ── Stale --check goldens ─────────────────────────────────────────────

    def test_check_exits_1_on_stale(self):
        """The --check flag detects a stale artifact — against a TEMP COPY,
        never the tracked file (the test must leave the worktree clean)."""
        result = subprocess.run(
            [sys.executable, os.path.join(HERE, "build_changelog.py"), "--check"],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, "--check should pass on a fresh artifact")
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with open(OUT) as f:
                original = json.load(f)
            with open(tmp_path, "w") as f:
                json.dump(original, f)
            tampered = {"versions": [{"version": "v0.0.0", "date": "", "title": "TAMPERED"}]}
            with open(tmp_path, "w") as f:
                json.dump(tampered, f)
            stale = subprocess.run(
                [sys.executable, os.path.join(HERE, "build_changelog.py"),
                 "--check", "--out", tmp_path],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertNotEqual(stale.returncode, 0,
                                "--check must exit 1 on stale artifact")
            self.assertIn("stale", (stale.stderr + stale.stdout).lower())
            # The tracked artifact must be byte-identical to what we read
            # (the test never writes OUT).
            with open(OUT) as f:
                self.assertEqual(json.load(f), original, "OUT was modified by the test")
        finally:
            os.unlink(tmp_path)

    def test_breaking_marker_subjects_parse(self):
        """Conventional `feat!:` and `feat(scope)!:` subjects parse — the
        SUBJECT_RE carries the `!?` marker between scope and colon (a
        rebuttal-with-evidence for the 'breaking changes drop out' review
        finding)."""
        for subject in (
            "feat!: drop the one-time share link",
            "feat(units)!: measured rounding vocabulary (ADR-0054) (#51)",
        ):
            parsed = _build_changelog.parse_subject(subject)
            self.assertIsNotNone(parsed, subject)
            self.assertEqual(parsed["type"], "feat")
            self.assertNotIn("!", parsed["text"])

    # ── Sort goldens ──────────────────────────────────────────────────────

    def test_semver_sort_key_prerelease_ordering(self):
        """A prerelease sorts between the previous release and its own
        release (ADR-0060 §2)."""
        key = _build_changelog.semver_sort_key
        self.assertLess(key("v2.2.0"), key("v2.3.0-rc1"))
        self.assertLess(key("v2.3.0-rc1"), key("v2.3.0"))
        self.assertLess(key("v2.3.0-rc1"), key("v2.3.0-rc2"))
        self.assertLess(key("v2.2.0"), key("v2.2.1"))

    def test_authored_table_references_real_tags(self):
        """The grandfathered table only overrides tags that EXIST (ADR-0060
        §3 as amended): no ghost entries, and each override is a real
        editorial title. New tags derive their title from the semantic
        commits — coverage is asserted on the ARTIFACT
        (test_all_tags_present), not on this table."""
        tags = set(
            subprocess.check_output(["git", "tag", "-l", "v*"], encoding="utf8").split()
        )
        ghosts = sorted(set(_build_changelog.AUTHORED_TITLES) - tags)
        self.assertEqual(ghosts, [], "table entries for unknown tags: %s" % ghosts)
        for tag, title in _build_changelog.AUTHORED_TITLES.items():
            self.assertTrue(len(title) > 3, "%s: title too short" % tag)
            self.assertFalse(title.startswith("v"), "%s: title starts with v" % tag)
            self.assertNotIn(": ", title, "%s: title looks like a commit subject" % tag)


if __name__ == "__main__":
    raise SystemExit(unittest.main(verbosity=2))
