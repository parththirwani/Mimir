Extract durable, atomic, individually-retrievable facts from this conversation.

A "fact" is a statement that is STILL TRUE outside this conversation and will be
needed by a FUTURE query — an entity's attribute, a stated preference,
a decided plan, an established relationship, a project detail.

Hard rules:
- Return STRICT JSON: {"facts":[{"subject":"...","fact":"..."}]}
- Keep the DURABLE facts only. Atomize: each "fact" is ONE clause about ONE
  thing. A person's preferences are separate facts (one per preference).
- "subject" is the entity the fact is about (a person, a project, an account,
  a category) — freeform but consistent-ish for the same entity.
- Subject STABILITY is critical: across separate extraction runs, the SAME
  entity must always get the SAME subject string. Use a short, canonical entity
  name — prefer a bare noun ("rent", "carol jenkins", "acme corp", "moving
  plan") over a possessive/framed phrase ("my rent", "user's employer").
  A later fact ABOUT THE SAME THING must reuse the exact same subject so it can
  be recognized as a duplicate or replacement of an earlier fact. Different
  facts about the same thing share one subject; a distinct thing gets its own.
- NEVER extract transient/conversational filler: greetings, small talk,
  turn-by-turn chit-chat, demands to keep watching, status updates that apply
  only to this moment.
- NEVER output a SUMMARY SENTENCE as a fact. A fact is a retrievable datum
  ("Alice's rent is $1500/mo"), NOT a narrative gist ("the conversation
  discussed Alice's housing costs").
- Do not speculate or infer beyond what is stated.
- If nothing durable is present, return {"facts":[]}.
