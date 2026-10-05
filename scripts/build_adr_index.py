#!/usr/bin/env python3
"""Generate docs/design/index.md from the ADR files in that folder.

The "notable ADRs" summary used to be a hand-maintained paragraph in the
repo-root AGENTS.md. It drifted (an ADR landing never edited it) and it was a
lossy copy of the folder anyway. This script lists the records and writes a
markdown index; AGENTS.md links to the result and is not edited per-ADR, which
is what makes "no need to keep updating AGENTS.md" true.

    python3 scripts/build_adr_index.py            # write docs/design/index.md
    python3 scripts/build_adr_index.py --check    # exit 1 if stale (never writes)
    python3 scripts/build_adr_index.py --next     # print the next free ADR number

`--check` compares content and never writes, so the gate is able to fail.
`--next` is how you pick a number when starting a record: ask the folder, do
not count on your fingers (which is how ADR-0027 ended up used three times).
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN_DIR = os.path.join(ROOT, "docs", "design")
OUT_PATH = os.path.join(DESIGN_DIR, "index.md")

# README.md is prose about the folder; ADR-*.md are the records.
ADR_RE = re.compile(r"^ADR-(\d{4})-(.+)\.md$")
TITLE_RE = re.compile(r"^#\s*(.+)$", re.M)
STATUS_RE = re.compile(r"status\s*:?\s*\**\s*([^\n*]+)", re.I)
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
SUPERSEDES_RE = re.compile(r"supersedes\b[^\n]{0,80}?\[?(adr-\d{4})", re.I)
SUPERSEDED_BY_RE = re.compile(r"superseded\s+(?:in\s+part\s+)?by\s+\[?(adr-\d{4})", re.I)


def classify(raw):
    """Collapse the free-text Status field into a few buckets.

    Records write status as prose ('accepted (2026-09-29)', 'accepted (share
    URL 2026-09-23; superseded-in-part by ADR-0051)'). The index needs one
    sortable column, and what an agent needs to know before skimming is whether
    the record still governs -- a supersession question, not a date one.

    The supersession test matches the PAST PARTICIPLE `superseded`, never the
    stem: a live record reads 'Accepted (supersedes ADR-0035)', and keying on
    `supersed` filed that governing record under "Not in force" -- the exact
    inversion the table exists to prevent. Direction is the whole signal:
    `superseded by X` retires this record, `supersedes X` retires another.
    """
    s = raw.lower()
    if re.search(r"superseded", s):
        # 'superseded-in-part' still stands for what it does cover, so it stays
        # in force rather than being lumped in with the fully retired records.
        # The separator varies across records (hyphen, space, slash), so match
        # the words either side of it rather than one literal spelling.
        if re.search(r"in[\s\-/]*part", s):
            return "accepted (superseded in part)"
        return "superseded"
    if s.startswith("proposed") or "design approved" in s:
        return "proposed"
    return "accepted"  # 'shipped' and 'accepted ... implemented in #41' govern


def git_added_date(rel):
    """The commit date that ADDED the file -- the authoritative record date.

    Three records (ADR-0036, ADR-0042, ADR-0052) carry no `Date:` line at all,
    and the folder's own convention is inconsistent about the field. Rather
    than invent dates in the records, ask git: when the decision was written
    down is when the file landed. Returns '' outside a git checkout, and the
    caller degrades to '—'.
    """
    try:
        out = subprocess.run(
            ["git", "log", "--diff-filter=A", "--format=%ad", "--date=short", "-1",
             "--", os.path.join("docs", "design", rel)],
            cwd=ROOT, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


def parse(path):
    with open(path) as f:
        text = f.read()
    head = text[:3000]
    m = TITLE_RE.search(head)
    title = m.group(1).strip() if m else os.path.basename(path)
    # Drop the 'ADR-0001: ' prefix; the index has its own number column.
    # Separators seen in the wild: ': ', ' — ', ' - ', and ' · ' (ADR-0041).
    title = re.sub(r"^ADR-\d{4}\s*[:—–·-]\s*", "", title).strip()
    m = STATUS_RE.search(head)
    raw = m.group(1).strip().strip("*").strip() if m else "accepted"
    m = DATE_RE.search(head)
    rel = os.path.basename(path)
    date = m.group(1) if m else git_added_date(rel)
    sup = SUPERSEDES_RE.search(head)
    num, slug = rel[4:8], rel[9:-3]   # ADR-NNNN-slug.md
    return {
        "num": num,
        "slug": slug,
        "file": rel,
        "title": title,
        "status": classify(raw),
        "date": date,
        "supersedes": sup.group(1).upper() if sup else "",
    }


def records():
    return [parse(os.path.join(DESIGN_DIR, f))
            for f in sorted(os.listdir(DESIGN_DIR)) if ADR_RE.match(f)]


def next_number(adrs):
    """The next free ADR number: one past the highest in use.

    Deliberately max()+1 rather than count()+1. The two disagree today --
    57 files share 52 numbers -- and count() would hand out ADR-0053 to a
    record that is already taken. Max is correct under duplicates; count is
    only correct when the numbering is dense, which is exactly the assumption
    that broke in the first place.
    """
    return max(int(a["num"]) for a in adrs) + 1


def build():
    adrs = records()

    out = []
    w = out.append
    w("# Decision record index")
    w("")
    w("Generated by `scripts/build_adr_index.py` from the records in this")
    w("folder — **do not hand-edit**; edit the ADR, then run")
    w("`bun run data:adr-index`. The repo-root `AGENTS.md` links here and is")
    w("not updated per ADR.")
    w("")
    w(f"**{len(adrs)} records.** One file per decision (`ADR-NNNN-slug.md`),")
    w("template **Status / Date / Context / Decision / Consequences /")
    w("Alternatives considered**. A superseding decision is a NEW ADR that")
    w("flips the old one's Status; accepted records are never rewritten in place.")
    w("")

    by_num = {}
    for a in adrs:
        by_num.setdefault(a["num"], []).append(a)

    live = sorted([a for a in adrs if a["status"] == "accepted"],
                  key=lambda a: (a["num"], a["slug"]))
    other = sorted([a for a in adrs if a["status"] != "accepted"],
                   key=lambda a: (a["num"], a["slug"]))

    w("## In force")
    w("")
    w(f"The {len(live)} accepted records below all still govern. Skim the ones")
    w("near your change before proposing anything -- they encode *why* the")
    w("architecture is shaped the way it is.")
    w("")
    w("| ADR | Decision | Date |")
    w("| --- | --- | --- |")
    for a in live:
        note = f" _(supersedes {a['supersedes']})_" if a["supersedes"] else ""
        w(f"| [{a['num']}]({a['file']}) | {a['title']}{note} | {a['date'] or '—'} |")
    w("")

    if other:
        w("## Not in force")
        w("")
        w("Superseded, superseded-in-part and proposed records. Read these to")
        w("understand why the current shape is the shape.")
        w("")
        w("| ADR | Decision | Status | Date |")
        w("| --- | --- | --- | --- |")
        for a in other:
            w(f"| [{a['num']}]({a['file']}) | {a['title']} | {a['status']} | {a['date'] or '—'} |")
        w("")

    dupes = {n: v for n, v in by_num.items() if len(v) > 1}
    nxt = next_number(adrs)
    if dupes:
        w("## Known numbering collisions")
        w("")
        w("Each of these numbers is used by more than one file. Recorded, not")
        w("renumbered: renumbering would break cross-references in AGENTS.md, in")
        w("the ADR bodies and in commit messages. Cite these by slug. Fixing it")
        w("is a deliberate migration, not a regeneration.")
        w("")
        for n in sorted(dupes):
            w(f"- **ADR-{n}** -- " + ", ".join(f"`{a['file']}`" for a in dupes[n]))
        w("")

    w("## Adding a record")
    w("")
    w(f"1. Ask for the number: `python3 scripts/build_adr_index.py --next`"
      f" (currently **{nxt:04d}**). Do not count the files -- that is how the")
    w(f"   collisions above happened ({len(adrs)} files share"
      f" {len(by_num)} numbers).")
    w("2. `ADR-NNNN-slug.md` here, on the template above.")
    w("3. If it supersedes one, say so in both records' Status lines.")
    w("4. `bun run data:adr-index` and commit the regenerated `index.md`.")
    w("5. Nothing else -- `AGENTS.md` links here.")
    w("")
    return "\n".join(out)


def main():
    if "--next" in sys.argv:
        print("%04d" % next_number(records()))
        return 0
    body = build()
    if "--check" in sys.argv:
        if not os.path.exists(OUT_PATH):
            print("check failed: index.md missing -- run `bun run data:adr-index`")
            return 1
        with open(OUT_PATH) as f:
            if f.read() != body:
                print("check failed: index.md is stale -- run `bun run data:adr-index`")
                return 1
        print("check ok: index.md is current")
        return 0
    with open(OUT_PATH, "w") as f:
        f.write(body)
    print("wrote docs/design/index.md (%d records)" % body.count("](ADR-"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
