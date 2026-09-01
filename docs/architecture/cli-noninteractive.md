# Non-interactive CLI Host

Phase 12E adds a production print host for scripts and CI while keeping the existing interactive Ink client thin.

## Invocation and input

```bash
caelush -p "Explain this project"
echo "Run tests and summarize" | caelush -p
caelush -p "Check project" --output-format json
```

`-p`/`--print` selects non-interactive mode and never creates an Ink renderer. The prompt may be one argument or strict UTF-8 stdin. The existing `MAX_CLI_PROMPT_BYTES` bound (32 KiB) is reused. Argument plus non-empty stdin is rejected, invalid UTF-8 is rejected, and empty stdin without an argument is a usage error for a new print Run. A missing prompt on a TTY does not wait for interactive input.

`-c`/`--continue` and exact `-r`/`--resume <SESSION_ID>` can be combined with print mode. The resume picker is intentionally incompatible with print mode because a machine-readable host cannot make an interactive Session choice.

## Output contract

Text mode reserves stdout for the verified final assistant text. JSON mode emits exactly one bounded public result document. Stream JSON emits newline-delimited records for `USER_VISIBLE` AgentEvents followed by one result record. Hidden reasoning, system prompts, provider payloads, tool arguments, raw output, credentials, and internal IDs not required by the public result are not emitted. Diagnostics and failure explanations go to stderr.

The final candidate is accepted only after the daemon returns a valid `VerifiedRunFinalResult`; model text alone never makes a successful print result. A non-success Run is represented by a public-safe result and a stable non-zero exit code.

## Approval and cancellation

Print mode never opens `ApprovalDialog` and never auto-approves. A Run at `WAITING_APPROVAL` stays durable and resumable; print mode emits an approval-required result and exits with code `5`. `Ctrl+C` sends the existing typed Core cancellation action, waits for canonical `CANCELLED` settlement, and exits `130`. It does not synthesize local cancellation state or stop the detached daemon.

## TTY and exit codes

Interactive mode requires both stdin and stdout TTYs. A non-TTY invocation receives:

```text
Interactive Caelush requires a terminal.
Use `caelush --print "..."` for non-interactive execution.
```

The product host centralizes exit codes: success `0`, doctor failure `1`, usage `2`, bootstrap failure `3`, terminal failure `4`, approval required `5`, transport failure `6`, and user cancellation `130`.
