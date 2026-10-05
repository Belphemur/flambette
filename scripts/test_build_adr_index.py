#!/usr/bin/env python3
"""Goldens for the ADR index generator (scripts/build_adr_index.py).

Same discipline as test_extract_ingredients.py: assert against the COMMITTED
artifact, never regenerate it first. A golden that refreshes its own subject
cannot fail on a stale file, and index.md is what AGENTS.md links to — a
silently stale index sends an agent to read a record that no longer says what
the table claims.
"""
import importlib.util
import json
import os
import re
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, "docs", "design", "index.md")
DESIGN = os.path.join(ROOT, "docs", "design")

spec = importlib.util.spec_from_file_location(
    "build_adr_index", os.path.join(HERE, "build_adr_index.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestIndexOutput(unittest.TestCase):
    """Assertions on the committed docs/design/index.md as it sits on disk."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(INDEX):
            raise AssertionError("docs/design/index.md missing — run "
                                 "`bun run data:adr-index`")
        with open(INDEX) as f:
            cls.text = f.read()
        cls.links = re.findall(r"\]\((ADR-\d{4}-[^)]+\.md)\)", cls.text)

    def test_the_committed_index_is_not_stale(self):
        # The gate that matters: a fresh build must MATCH what is committed.
        # --check is the same assertion in script form; calling main() here
        # would silently repair the file and make this unfailable.
        self.assertEqual(mod.build(), self.text,
                         "committed index.md is stale — run `bun run data:adr-index`")

    def test_every_record_is_listed_exactly_once(self):
        on_disk = sorted(f for f in os.listdir(DESIGN)
                         if re.match(r"^ADR-\d{4}-.+\.md$", f))
        self.assertEqual(sorted(self.links), on_disk,
                         "index.md does not list every ADR exactly once")

    def test_no_link_is_broken(self):
        # A link into a file that was renamed or removed is worse than no
        # index: it looks authoritative and 404s the reader.
        for link in set(self.links):
            self.assertTrue(os.path.exists(os.path.join(DESIGN, link)),
                            "index.md links a missing file: %s" % link)

    def test_every_record_carries_a_date(self):
        # Three records shipped with no Date line; the generator falls back to
        # git. A fourth unresolved row means the fallback stopped working.
        unresolved = re.findall(r"^\| \[\d{4}\]\([^)]+\) \|.*\| — \|$",
                                self.text, re.M)
        # A record that is not yet committed cannot be found by
        # `git log --diff-filter=A`, so its date stays blank until it lands.
        # That is an ordering artefact, not a broken fallback — but anything
        # else is a real failure.
        uncommitted = set()
        for f in os.listdir(DESIGN):
            if not re.match(r"^ADR-\d{4}-.+\.md$", f):
                continue
            if subprocess.run(["git", "ls-files", "--error-unmatch",
                               os.path.join("docs", "design", f)],
                              cwd=ROOT, capture_output=True).returncode != 0:
                uncommitted.add(f)
        self.assertLessEqual(
            len(unresolved), len(uncommitted),
            "%d record(s) have no resolvable date but only %d are uncommitted — "
            "the git fallback broke" % (len(unresolved), len(uncommitted)))

    def test_status_column_is_from_the_known_set(self):
        # Only the "Not in force" table has a Status column; the "In force" one
        # is | ADR | Decision | Date |. Match the 4-column row shape.
        allowed = {"accepted", "proposed", "superseded",
                   "accepted (superseded in part)"}
        rows = re.findall(r"^\| \[\d{4}\]\([^)]+\) \|[^|]*\|([^|]*)\| [^|]+ \|$",
                          self.text, re.M)
        self.assertTrue(rows, "no 4-column rows found — table shape changed?")
        for st in rows:
            self.assertIn(st.strip(), allowed, "unknown status bucket %r" % st)

    def test_collisions_are_disclosed_not_hidden(self):
        # The folder currently reuses four numbers. The index must SAY so: the
        # alternative is two records sharing a number with nothing warning a
        # reader which one a bare 'ADR-0038' refers to.
        by_num = {}
        for f in os.listdir(DESIGN):
            m = re.match(r"^ADR-(\d{4})-", f)
            if m:
                by_num.setdefault(m.group(1), []).append(f)
        dupes = {n for n, v in by_num.items() if len(v) > 1}
        if not dupes:
            self.assertNotIn("Known numbering collisions", self.text,
                             "no collisions exist — drop the section")
            return
        for n in sorted(dupes):
            self.assertIn("ADR-%s" % n, self.text,
                          "collision on ADR-%s is not disclosed" % n)

    def test_next_number_is_free_and_above_every_record(self):
        used = {int(a["num"]) for a in mod.records()}
        nxt = mod.next_number(mod.records())
        self.assertNotIn(nxt, used, "--next handed out a number already in use")
        self.assertGreater(nxt, max(used),
                           "--next must be above every record, not just unused")

    def test_next_number_uses_max_not_count(self):
        # 57 files share 52 numbers, so count()+1 (0058) collides with a real
        # record while max()+1 (0053) is correct. This is the specific bug that
        # produced the collisions; pin the arithmetic.
        adrs = mod.records()
        self.assertEqual(mod.next_number(adrs), max(int(a["num"]) for a in adrs) + 1)

    def test_the_build_is_idempotent(self):
        self.assertEqual(mod.build(), mod.build())

    def test_agents_md_links_the_index_instead_of_restating_it(self):
        # The whole point: adding an ADR must not require editing AGENTS.md. If
        # AGENTS.md grows a per-ADR summary again, this fails.
        with open(os.path.join(ROOT, "AGENTS.md")) as f:
            agents = f.read()
        self.assertIn("docs/design/index.md", agents,
                      "AGENTS.md must link the generated index")
        # The bullet is '- **Design ADRs**:', not a '## ' heading, so anchor on
        # the label and read forward to the next top-level section.
        start = agents.find("**Design ADRs**")
        self.assertNotEqual(start, -1, "AGENTS.md lost its 'Design ADRs' bullet")
        rest = agents[start:]
        nxt = re.search(r"^## ", rest, re.M)
        section = rest[:nxt.start()] if nxt else rest
        # A list of many bare ADR numbers means the summary is back.
        cited = re.findall(r"ADR-\d{4}", section)
        self.assertLessEqual(len(cited), 2,
                             "AGENTS.md is restating %d ADRs — it should link the "
                             "index, not duplicate it" % len(cited))


if __name__ == "__main__":
    unittest.main(verbosity=2)
