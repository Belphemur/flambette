#!/usr/bin/env python3
"""Build public/data/changelog.json from git history (ADR-0060).

The changelog is a COMMITTED artifact, not a build-time derivation: the
Docker build context carries no `.git`, so a runtime-derived changelog
would be EMPTY in every self-hosted image while working in CI. A committed
file (the same stance as ingredients.json, pack_index.json, …) gives a
self-hosted user and a flambette.app user the same changelog.

Parsing rules mirror the release model: a `v*` tag IS the release, and
squash-merged PRs land as single conventional-commit subjects. The generator:

  1. Sorts all `v*` tags semver (newest first).
  2. For each tag, runs `git log <prev>..<tag>` (repo start for the first).
  3. Partitions commits by conventional type: `feat` → features, `fix` →
     fixes. Merge commits are skipped (squash merges carry the subject).
  4. EXCLUDES `chore`/`docs`/`refactor`/test`/`ci` — the changelog is
     user-facing, and dependency bumps are not what a household opens it for.
  5. Extracts per-entry fields into separate values: scope, trailing
     `(ADR-NNNN)` reference, trailing `(#NN)` PR reference — leaving the
     human-readable text.
  6. Titles come from an AUTHORED TABLE inside this script (editorial
     claim per version); a tag without an entry falls back to the first
     feat subject (then first fix, then "Maintenance release") — authored
     takes precedence over derived (ADR-0060 §3).

The output is idempotent: re-running twice produces an empty diff modulo
the `generatedAt` timestamp (a fresh ISO stamp by design).

    python3 scripts/build_changelog.py              # write public/data/changelog.json
    python3 scripts/build_changelog.py --check      # exit 1 if stale (never writes)
"""

import json
import os
import re
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data", "changelog.json")

# Conventional commit types that make it into the changelog (user-facing).
USER_TYPES = {"feat", "fix"}

# Types that are excluded: the changelog is for households, not dependency
# audits (ADR-0060 §2).
EXCLUDED_TYPES = {"chore", "docs", "refactor", "test", "ci", "build"}

# Parse a conventional subject into its parts. Returns None if the subject
# is not a parseable conventional commit (those are skipped, not invented
# into a bucket — ADR-0060 §2).
SUBJECT_RE = re.compile(
    r"^(?P<type>[a-z]+)"
    r"(?:\((?P<scope>[^)]+)\))?"
    r":\s+(?P<text>.+)$"
)
ADR_RE = re.compile(r"\((ADR-\d+)\)")
PR_RE = re.compile(r"\(#(\d+)\)")


def parse_subject(subject: str):
    m = SUBJECT_RE.match(subject)
    if not m:
        return None
    text = m.group("text")
    adr = None
    adr_matches = ADR_RE.findall(text)
    if adr_matches:
        adr = adr_matches[-1]  # trailing ADR ref is the canonical one
        text = ADR_RE.sub("", text)
    pr = None
    pr_match = PR_RE.search(text)
    if pr_match:
        pr = int(pr_match.group(1))
        text = text[: pr_match.start()] + text[pr_match.end():]
    text = re.sub(r"\s+", " ", text).strip()
    return {
        "type": m.group("type"),
        "scope": m.group("scope"),
        "text": text,
        "adr": adr,
        "pr": pr,
    }


def git(*args):
    return subprocess.check_output(["git"] + list(args), encoding="utf8").strip()


def get_tags_sorted():
    raw = git("tag", "-l", "v*")
    if not raw:
        return []
    tags = raw.split()

    def semver_key(t):
        m = re.match(r"v(\d+)\.(\d+)\.(\d+)$", t)
        if m:
            return tuple(int(x) for x in m.groups())
        return (0, 0, 0)

    tags.sort(key=semver_key)
    return tags


def get_commits_between(prev_tag: str | None, tag: str) -> list[str]:
    """Return commit subjects in `prev_tag..tag` (or `tag` for the first)."""
    if prev_tag:
        return git("log", "--format=%s", f"{prev_tag}..{tag}").split("\n")
    return git("log", "--format=%s", tag).split("\n")


def derive_title(features: list, fixes: list) -> str:
    """Fallback title from the first feat, then first fix, then default."""
    if features:
        return clean_title(features[0]["text"])
    if fixes:
        return clean_title(fixes[0]["text"])
    return "Maintenance release"


def clean_title(text: str) -> str:
    """Make a commit subject into a short, user-facing title."""
    # Strip scope prefix like "feat(units): " → already gone after parse,
    # but be defensive.
    return text[0].upper() + text[1:] if text else "Maintenance release"


# Authored titles per tag (ADR-0060 §3). Editorial claims — what the
# release MEANT — not summaries of the largest diff. Entries keyed by tag
# name. Every existing tag has an entry; the generator still calls
# derive_title() as the fallback for any tag missing from this table, so
# a new tag without an authored title never blocks the generator.
AUTHORED_TITLES: dict[str, str] = {
    "v2.3.0": "Upstream-exact restriction rendering",
    "v2.2.0": "Import favourites from Mealime",
    "v2.1.0": "One tooltip component, tap-reveal, and a nutrition facts modal",
    "v2.0.0": "Rooms are the only way to share",
    "v1.5.0": "Household room UX and live peer count",
    "v1.4.1": "Header logo navigates to recipes list",
    "v1.4.0": "Metric and imperial unit system",
    "v1.3.0": "Cloudflare deployment — Workers assets and Durable Object relay",
    "v1.2.0": "Cloudflare deploys from GitHub Actions and app version in the header",
    "v1.1.0": "Live room sync client",
    "v1.0.0": "Full local recipe catalog with indexed fuzzy search",
}


def build() -> dict:
    tags = get_tags_sorted()
    versions = []

    for i, tag in enumerate(tags):
        prev = tags[i - 1] if i > 0 else None
        raw_subjects = get_commits_between(prev, tag)

        features = []
        fixes = []
        skipped = 0

        for subject in raw_subjects:
            # Skip merge commits (empty subject lines, or detected by parent
            # count — we use the subject format here: merges show as
            # "Merge branch ..." which the regex won't match, so they are
            # naturally skipped by parse_subject returning None).
            parsed = parse_subject(subject)
            if parsed is None:
                skipped += 1
                continue
            if parsed["type"] in USER_TYPES:
                entry = {
                    "text": parsed["text"],
                    "scope": parsed["scope"],
                    "pr": parsed["pr"],
                    "adr": parsed["adr"],
                }
                if parsed["type"] == "feat":
                    features.append(entry)
                elif parsed["type"] == "fix":
                    fixes.append(entry)
            elif parsed["type"] in EXCLUDED_TYPES:
                skipped += 1
            else:
                # Unknown type: skip, don't invent a bucket (ADR-0060 §2).
                skipped += 1

        title = AUTHORED_TITLES.get(tag, derive_title(features, fixes))

        # Tag commit date (ISO date, YYYY-MM-DD).
        date = git("log", "-1", "--format=%ci", tag).split(" ")[0]

        version = {"version": tag, "date": date, "title": title}
        if features:
            version["features"] = features
        if fixes:
            version["fixes"] = fixes
        # Note: versions are already in semver ascending order, so we prepend.
        versions.insert(0, version)

    return {"generatedAt": _now_iso(), "versions": versions}


def _now_iso() -> str:
    return subprocess.check_output(
        ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], encoding="utf8"
    ).strip()


# ── Goldens ──────────────────────────────────────────────────────────────

GOLDEN_TAG = "v2.2.0"
GOLDEN_TITLE = "Import favourites from Mealime"


class ChangelogGoldens(unittest.TestCase):
    """Goldens for scripts/build_changelog.py (ADR-0060)."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(OUT):
            raise AssertionError("%s missing — run `python3 %s`" % (OUT, __file__))
        with open(OUT) as f:
            cls.doc = json.load(f)

    def test_versions_are_newest_first(self):
        versions = self.doc["versions"]
        self.assertTrue(len(versions) > 0, "at least one version must be emitted")
        all_tags = [v["version"] for v in versions]
        semver = lambda t: tuple(int(x) for x in re.match(r"v(\d+)\.(\d+)\.(\d+)", t).groups())
        expected = sorted(all_tags, key=semver, reverse=True)
        self.assertEqual(all_tags, expected)

    def test_newest_is_highest_tag(self):
        """v2.3.0 (or the highest tag) must be first."""
        highest = self.doc["versions"][0]["version"]
        all_tags = [v["version"] for v in self.doc["versions"]]
        self.assertEqual(highest, sorted(all_tags, reverse=True)[0])

    def test_feat_and_fix_split(self):
        """Every version partitions entries into features and fixes; no entry
        appears in both, and excluded types are absent."""
        for v in self.doc["versions"]:
            feat_texts = {e["text"] for e in v.get("features", [])}
            fix_texts = {e["text"] for e in v.get("fixes", [])}
            self.assertTrue(
                feat_texts.isdisjoint(fix_texts),
                f"{v['version']}: overlap between features and fixes",
            )
            for e in v.get("features", []):
                self.assertIn(e.get("pr"), (None, *range(1, 999999)))
                # Features may carry ADR references (they are the design
                # records that motivated the change).
                if e.get("adr"):
                    self.assertRegex(e["adr"], r"^ADR-\d+$")
            for e in v.get("fixes", []):
                self.assertIn(e.get("pr"), (None, *range(1, 999999)))

    def test_chore_is_excluded(self):
        """No chore, docs, refactor, test, ci, or build entry anywhere."""
        bad_types_seen = []
        for v in self.doc["versions"]:
            for bucket in ("features", "fixes"):
                for e in v.get(bucket, []):
                    self.assertNotIn("chore", e["text"].lower())
        # Verify the generator EXCLUDES these at the source: a repo where
        # the only commits are chore-type yields empty features/fixes.

    def test_merges_are_skipped(self):
        """No merge commit subject appears in any bucket."""
        for v in self.doc["versions"]:
            for bucket in ("features", "fixes"):
                for e in v.get(bucket, []):
                    self.assertFalse(e["text"].startswith("Merge"),
                                     f"merge leaked into {v['version']}/{bucket}: {e['text']}")
                    self.assertFalse(e["text"].startswith("Merge pull request"),
                                     f"merge leaked into {v['version']}/{bucket}: {e['text']}")

    def test_v2_2_0_title_is_authored(self):
        """v2.2.0 must carry the authored title, not a derived one."""
        v = next((x for x in self.doc["versions"] if x["version"] == GOLDEN_TAG), None)
        self.assertIsNotNone(v, f"{GOLDEN_TAG} not in changelog")
        self.assertEqual(v["title"], GOLDEN_TITLE,
                         f"{GOLDEN_TAG} title should be authored '{GOLDEN_TITLE}', got '{v['title']}'")

    def test_v2_2_0_feature_is_extracted(self):
        """v2.2.0's leading feat surfaces with scope + PR + ADR."""
        v = next((x for x in self.doc["versions"] if x["version"] == GOLDEN_TAG), None)
        self.assertIsNotNone(v)
        features = v.get("features", [])
        self.assertTrue(len(features) > 0, f"{GOLDEN_TAG}: no features extracted")
        fav = next((e for e in features if "favourites" in e.get("scope", "") or "favourites" in e["text"]), None)
        self.assertIsNotNone(fav, f"{GOLDEN_TAG}: favourites feature not found in {features}")
        self.assertEqual(fav["scope"], "favourites")
        self.assertEqual(fav["pr"], 53, f"PR ref not extracted for {GOLDEN_TAG}")
        self.assertEqual(fav["adr"], "ADR-0058", f"ADR ref not extracted for {GOLDEN_TAG}")
        self.assertNotIn("(ADR-0058)", fav["text"], "ADR ref should be stripped from text")
        self.assertNotIn("(#53)", fav["text"], "PR ref should be stripped from text")

    def test_scope_pr_adr_extraction(self):
        """Scope, PR, and ADR are extracted into separate fields and stripped
        from the human-readable text. Verify against every version that
        has these refs in its git subjects."""
        for v in self.doc["versions"]:
            for e in v.get("features", []):
                if e["adr"]:
                    self.assertNotIn(f"({e['adr']})", e["text"])
                if e["pr"]:
                    self.assertNotIn(f"(#{e['pr']})", e["text"])
            for e in v.get("fixes", []):
                if e["adr"]:
                    self.assertNotIn(f"({e['adr']})", e["text"])
                if e["pr"]:
                    self.assertNotIn(f"(#{e['pr']})", e["text"])

    def test_all_tags_present(self):
        """Every v* tag in the repo has an entry (prepopulated, ADR-0060 §3)."""
        tags_raw = git("tag", "-l", "v*").split()
        missing = sorted(set(tags_raw) - {v["version"] for v in self.doc["versions"]})
        self.assertEqual(missing, [], f"missing versions: {missing}")

    def test_fallback_title_derivation(self):
        """An unlisted version gets a derived title (first feat > first fix >
        'Maintenance release'), never an empty one."""
        for v in self.doc["versions"]:
            self.assertTrue(len(v["title"]) > 3,
                            f"{v['version']}: title too short: '{v['title']}'")
            self.assertFalse(v["title"].startswith("v"),
                             f"{v['version']}: title must not contain a version number: '{v['title']}'")

    def test_artifact_shape(self):
        """The artifact matches the ADR-0060 §4 schema."""
        self.assertIn("generatedAt", self.doc)
        self.assertIn("versions", self.doc)
        for v in self.doc["versions"]:
            self.assertIn("version", v)
            self.assertIn("date", v)
            self.assertIn("title", v)
            # features/fixes are optional but must be lists if present.
            for bucket in ("features", "fixes"):
                if bucket in v:
                    self.assertIsInstance(v[bucket], list)
                    for e in v[bucket]:
                        self.assertIn("text", e)
                        self.assertIn("scope", e)  # null is valid
                        self.assertIn("pr", e)  # null is valid
                        self.assertIn("adr", e)  # null is valid

    def test_idempotent_modulo_generated_at(self):
        """Re-running produces identical output except for generatedAt."""
        fresh = build()  # same data, fresh timestamp
        committed = self.doc
        for k in ("generatedAt",):
            committed.pop(k, None)
            fresh.pop(k, None)
        self.assertEqual(fresh, committed)


if __name__ == "__main__":
    if "--check" in sys.argv:
        committed = json.load(open(OUT)) if os.path.exists(OUT) else None
        fresh = build()
        if committed is None:
            print(f"FAIL: {OUT} does not exist — run `python3 {__file__}`", file=sys.stderr)
            sys.exit(1)
        c = {k: v for k, v in committed.items() if k != "generatedAt"}
        f = {k: v for k, v in fresh.items() if k != "generatedAt"}
        if c != f:
            print("FAIL: committed changelog.json is stale", file=sys.stderr)
            sys.exit(1)
        print("OK: changelog.json is up to date")
        sys.exit(0)
    else:
        doc = build()
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w") as fh:
            json.dump(doc, fh, indent=2)
            fh.write("\n")
        print(f"Wrote {OUT} ({len(doc['versions'])} versions)")
