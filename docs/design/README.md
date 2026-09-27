# Design decision records

This folder holds ADR-style decision records for the Mealime Planner.
One file per decision (`ADR-NNNN-slug.md`); template and conventions
inside each file: **Status / Date / Context / Decision / Consequences
/ Alternatives considered**.

Decisions with lasting effect go here at decision time (or backfilled
when revisited). Superseding writes a new ADR and flips the old one's
Status — accepted ADRs are not rewritten in place.

Any coding agent starting work on this repo should skim the accepted
ADRs before proposing changes: they encode *why* the architecture is
shaped the way it is (offline catalog, derived grocery, clear = remove,
rooms, Bun).
