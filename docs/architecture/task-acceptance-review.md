# Phase 11C Task Acceptance Review

The `TASK` check is an independent, no-tools reviewer. Its input is a canonical bounded bundle containing the original goal, Final Candidate text, immutable plan/check summaries, bounded prior evidence summaries, and Agent-attributed changed files. The bundle receives a SHA-256 `reviewInputHash`; the prompt itself is never persisted.

Candidate text, filenames, diffs, command output, and evidence are explicitly delimited as untrusted data. They can contain prompt-injection text but never become reviewer instructions. The reviewer returns strict JSON with `PASS` or `FAIL`, a short summary, and at most eight bounded repair suggestions. Unknown fields, markdown/tool calls, malformed JSON, incomplete evidence, and provider failures become `TASK ERROR`. Existing TASK evidence is excluded so a reviewer cannot self-certify from its own prior result.

Reviewer calls use the Run's selected model through the existing provider-neutral Gateway boundary and `toolChoice: NONE`. They do not create an Agent Step, emit solver `llm.started`, invoke Tools, or mutate the workspace. The shared Phase 10D budget ledger records them as `VERIFICATION_LLM`; exact usage settles normally and missing usage is conservative. A budget result remains authoritative over a reviewer verdict.
