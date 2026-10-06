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

import html
import json
import os
import re
import subprocess
import sys

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
    r"!?"
    r":\s+(?P<text>.+)$"
)
ADR_RE = re.compile(r"\((ADR-\d+)\)")
PR_RE = re.compile(r"\(#(\d+)\)")


def parse_subject(subject: str):
    m = SUBJECT_RE.match(subject)
    if not m:
        return None
    text = m.group("text")
    text = re.sub(r"^!", "", text)
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
    text = html.unescape(text)
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
    "v1.4.0": "Full TypeScript relay core and web worker observability",
    "v1.3.0": "Metric and imperial unit system",
    "v1.2.0": "Cloudflare deployment and app version in the header",
    "v1.1.0": "Live room sync client",
    "v1.0.0": "Full local recipe catalog with indexed fuzzy search",
}


def build() -> dict:
    tags = get_tags_sorted()
    # Exclude the tag at HEAD: the changelog documents released versions,
    # not the in-progress build (ADR-0060 §4).
    try:
        head_tag = git("describe", "--tags", "--exact-match", "HEAD")
        tags = [t for t in tags if t != head_tag]
    except subprocess.CalledProcessError:
        pass
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

        title = html.unescape(AUTHORED_TITLES.get(tag, derive_title(features, fixes)))

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



GOLDEN_TAG = "v2.2.0"
GOLDEN_TITLE = "Import favourites from Mealime"



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
