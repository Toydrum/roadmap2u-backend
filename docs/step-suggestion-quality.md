# Evaluating the dev step-suggestion pilot

The pilot suggests one small action within the current branch. A related noun or
valid JSON is not sufficient evidence that the suggestion is useful.

## Context and validation

The existing request supplies titles for the tree, branch, up to three ancestors,
one existing step and an optional focus. No new user data is collected. An existing
step is already represented; its presence alone does not prove completion.

For practice tasks, `practice-context.ts` separates explicit current intentions,
represented actions, completion statements and constraints from all relevant
clauses. A local shortcut requires a recognizable small action and preserves the
conditions. When interpretation is incomplete, the original request remains
available to the single model call. Derived `taskContext` fields are additional
guidance, not a replacement for the original focus. The model still returns a
structured exercise, whose anchors and activity are validated before rendering.

For ordinary tasks, `object-relations.ts` distinguishes stated locations from
assigned destinations, and associates each relation with its own object. Absence
does not establish availability. A named tool does not establish a destination.
Current-object and operation checks prevent selecting another true but irrelevant
fact from the context. Necessary constraints stay with the saved title.

Both model and local responses are checked for equivalence with their branch and
already represented steps. Known equivalent verbs and terminal punctuation are
normalized. This is bounded normalization, not universal semantic equivalence.

The parser recognizes explicit grammar and uses conservative rejection for
unsupported or contradictory responses. It does not prove comprehension of every
possible natural-language instruction. An unavailable result is a protected
failure, not a successful suggestion.

## Semantic acceptance criteria

Review the complete input and complete proposed title together. Record these
dimensions separately:

- Does it advance the current intended activity and object?
- Is it one small unit with an observable result, rather than the whole branch?
- Does it preserve relevant medium, method, location and other constraints?
- Does it avoid repeating represented or explicitly completed work?
- Are objects, materials, quantities and destinations supported by the context?
- If it asks a question, is that fact missing and necessary?

Accept valid alternatives. For example, a first note can be a useful part of a
three-note exercise. A mathematically valid operation can respect a restriction
without repeating its wording. Conversely, mentioning every expected word does
not make an incorrect object/destination pairing acceptable.

Classify each result as useful, borderline, incorrect, necessary clarification,
unnecessary clarification or technical rejection. Preserve the raw responses;
do not revise a rubric merely to make a candidate's score improve.

## Verification workflow

1. Reproduce known defects with unit and endpoint regression tests before fixing
   them. Keep quota, admission, privacy and one-call tests in the endpoint suite.
2. Freeze a separate set of new topics and phrasings before evaluating the
   implementation. Use only synthetic context for direct model evaluations.
3. Record the exact candidate, model calls, tokens, latency, rejections and full
   outputs. Review semantics independently of regex-based diagnostic scores.
4. Repeat stochastic cases after changes, and retain older valid cases to detect
   regressions. Do not present a difficult diagnostic sample as general accuracy.
5. After deployment to dev, verify authenticated clarification, generation,
   editing and saving with synthetic data when the account's quota permits.
   State explicitly which parts were blocked by quota. Never reset it or create
   another account to work around the daily cap.

The public contract, dev cohort, daily limit, maximum of one model call, 120-token
output limit and timeout remain separate invariants. Changing a model or any of
those bounds needs its own measured evaluation. This pilot is not enabled in
production.
