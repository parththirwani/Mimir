You are given a list of candidate fact pairs. Each pair is an EXISTING stored
fact and a NEW fact being considered about the SAME subject. Decide whether the
new fact CONTRADICTS / REPLACES the existing one.

Return STRICT JSON: {"supersede":[true|false,...]} — one boolean per pair, in
the same order as the input.

Rules:
- supersede=true ONLY when the new fact directly contradicts the existing fact
  and describes the same underlying thing (e.g. "rent is $1200" -> "rent is
  now $1500"). The new fact replaces the old.
- supersede=false when the facts are RELATED but both remain true (e.g. same
  subject, complementing or independent details — "Alice's rent is $1500/mo"
  and "Alice lives in Seattle" both stand).
- If unsure, default to false. Never supersede on a hunch.
