# V1 Security Threat Model — Phase 9D

Phase 9D seals the V1 security integration boundary. The goal is deterministic policy enforcement and secret-safe projections around the existing Tool, Runtime, Context, Approval, Event, and LLM contracts. It is not a claim that a local process is OS-isolated.

## Assets

- Host credentials and authentication material in the parent environment, credential files, helper configuration, and process metadata.
- Workspace and project files, including sensitive files, source-embedded credentials, instructions, Git metadata, and generated output.
- Durable ToolInvocation arguments and exact approval identity. These remain host-private execution data.
- Approval decisions, Tool observations, durable events, model messages, diagnostics, and logs.
- Runtime integrity: workspace lexical/realpath containment, bounded reads/writes/output, fixed helper invocation, and fail-closed policy decisions.

## Trust boundaries

1. User request and durable Run policy are trusted inputs to the host orchestration layer.
2. Model output, Tool arguments, repository files, project instructions, Git configuration, Git attributes, environment variables, and helper output are untrusted data.
3. Security Gate and logical sandbox admission are pure policy boundaries. They do not execute Tools or inspect approval state.
4. Dispatcher is the durable execution boundary: Gate first, approval infrastructure second, `RUNNING` checkpoint third, handler last.
5. Runtime is the local execution boundary. Structured workspace operations use path and realpath containment. Shell/process operations are explicitly `UNCONFINED_LOCAL_PROCESS` and receive a sanitized child environment.
6. Context is a model-input boundary. Sensitive paths are excluded before content reads, and project-derived text is redacted before provider messages. The current user message is not rewritten.
7. Event, observation, approval action, error, log, and model projections are public or semi-public surfaces and must not contain automatic raw secrets.

## Threats and mitigations

| Threat                                                        | V1 mitigation                                                                                                                        | Residual risk                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Malicious repository instructions grant themselves permission | Instructions are data; current Gate and durable Run policy remain authoritative                                                      | A user can explicitly request a dangerous action                           |
| Model chooses a path outside the workspace                    | Lexical and realpath checks fail closed; structured tools accept workspace-relative paths                                            | OS race conditions and external processes remain outside this boundary     |
| Sensitive file enters Context                                 | Unified Security classifier excludes sensitive files before reads; templates remain allowed                                          | Classifier is path-based and not complete DLP                              |
| Secret enters model/event/log projection                      | High-confidence redaction and result sanitization at projection boundaries                                                           | Redaction is not complete DLP; private invocation args can contain secrets |
| Old approval bypasses a new deny                              | Current Gate runs before exact RUN grant lookup; DENY wins                                                                           | Correctness depends on every host using the secure Dispatcher composition  |
| Missing approval persistence causes orphan waiting state      | Secure factory requires approval store and ID factory; Dispatcher fails closed                                                       | Low-level constructors remain available for tests/custom hosts             |
| Repository Git config executes a helper                       | Git uses fixed read-only commands, `shell:false`, no prompts, bounded IO, config hardening, and disabled ext diff/textconv/fsmonitor | `exec_command` intentionally remains an unconfined local process           |
| Host credentials reach a child                                | Runtime-owned allowlist strips credential, injection, proxy, SSH, and config variables; Windows names are case-insensitive           | The parent process and private durable invocation data are not erased      |
| Helper output overwhelms memory or leaks terminal control     | Bounded stdout/stderr and terminal sanitization                                                                                      | Malformed helper behavior is reported as a runtime error                   |

## V1 assumptions and non-protected surfaces

V1 assumes the host protects its own process memory, filesystem permissions, Node runtime, package installation, and trusted composition root. The logical sandbox does not provide seccomp, containers, Windows Job Objects, syscall filtering, network isolation, filesystem ACL changes, process identity isolation, remote execution isolation, or crash-atomic rollback. It also does not implement cancellation, timeout, retry, budget, Verification execution, MCP, Browser, or Phase 10 policy.
