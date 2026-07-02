# Pipeline Pattern Bank - recurring Paperclip finding classes

Append-only. Mined from shipped fixes, postmortems, and pipeline retros.

Format per entry: **class** - how it bites - the tell - canonical fix - source.

---

## Auth / authorization boundaries

- **governance-routine-write-needs-explicit-scoped-lane** - A company governance routine can have legitimate org-wide read authority but fail its required write side effect when the route only checks ordinary assignee, manager, or board-user mutation boundaries. The routine then either loses the nudge entirely or risks reporting the write as posted when it was rejected. - Tell: routine code reads an org-wide issue snapshot, then posts comments or releases locks across company issues using the same route as ordinary actors, with no narrow governance actor branch and no failure accounting. - Fix: add an explicit same-company governance write lane gated by actor role and operation shape, keep non-governance actors on the existing authorization boundary, and add regression tests for both allowed governance writes and rejected ordinary cross-boundary writes. - RR-4188.
