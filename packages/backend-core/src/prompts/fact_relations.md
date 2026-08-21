Propose directed relations between the newly extracted facts below and the
list of previously-known existing facts from this same thread.

A relation means: knowing one fact adds relevant context to the other, and
linking them once will help future retrieval pull both back together.

Return STRICT JSON only:
{"relations":[{"sourceIndex":0,"targetIndex":0,"relationType":"...","confidence":0.9}]}

- "sourceIndex" refers to a NEW fact index (0..N-1 in the new facts list).
- "targetIndex" refers to an EXISTING fact index (0..M-1 in the existing list).
- "relationType" is a short free-text tag ("affects", "predecessor_of", "preference_for", ...).
- "confidence" is 0..1. Only high-confidence relations matter.
- If no relation is warranted, return {"relations":[]}.