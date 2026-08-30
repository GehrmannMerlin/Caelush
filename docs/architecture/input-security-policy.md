# Input Security Policy

Phase 9C adds an input-aware policy overlay without replacing the Phase 9A metadata policy or the Phase 9B approval identity rules.

```text
Tool arguments (private)
        |
        v
validated Tool Security Facts (host-only, ephemeral)
        |
        +--> SensitivePathClassifier
        +--> command parser/classifier
        +--> SecretDetector
        |
        v
base metadata decision + monotonic input overlay
        |
        +--> redacted Approval preview
        +--> sanitized ToolObservation
        +--> structural-safe events
```

## Security Facts

`@caelush/tools` owns only the data contract and registration projector. Built-in projectors cover file reads, directory/file discovery, text search, patches, shell commands, stdin, Git status, and Git diff. They normalize workspace-relative separators and produce structural previews; patch bodies, stdin characters, and raw shell commands are not durable facts.

`@caelush/runtime` exposes only pure patch-target inspection so the patch projector does not duplicate patch grammar. A projector failure becomes `opaqueInput`; it is never ignored.

## Resource policy

Known environment, credential, authentication, cloud credential, private-key, and certificate-container paths require review. Absolute, escaping, or otherwise invalid fact paths are opaque. Template files such as `.env.example`, `.env.sample`, `.env.template`, and `.env.defaults` remain ordinary project resources.

## Command policy

The command analyzer tokenizes without executing. It handles common POSIX, PowerShell, and CMD separators and bounded wrappers (`sh/bash/zsh -c|-lc`, `env`, `sudo`, `powershell/pwsh -Command`, and `cmd /c`). The recursive wrapper limit is eight levels. Dynamic, encoded, ambiguous, or over-depth structures are `OPAQUE_DYNAMIC`.

Classifications are structural signals, not a safe-command allowlist:

`NORMAL_LOCAL`, `LOCAL_REPO_MUTATION`, `DESTRUCTIVE_LOCAL`, `NETWORK_ACCESS`, `REMOTE_MUTATION`, `PRIVILEGE_ESCALATION`, `SYSTEM_DESTRUCTIVE`, and `OPAQUE_DYNAMIC`.

System-destructive commands are always denied. Destructive local actions, network access, remote mutation, privilege escalation, and opaque commands require approval; `NEVER_ASK` converts those reviews to denial. A normal-looking command never downgrades a Phase 9A `REQUIRE_APPROVAL` decision for a critical shell Tool.

## Monotonic combination and approvals

The effective decision is computed as:

```text
validated request
  -> Phase 9A metadata decision
  -> security facts and input assessment
  -> DENY > REQUIRE_APPROVAL > ALLOW combination
  -> current Gate decision
  -> exact RUN grant lookup (only if still REQUIRE_APPROVAL)
```

A current input-aware `DENY` therefore cannot be bypassed by a cached grant. Redacted previews are presentation data only; exact approval keys continue to use private canonical arguments and policy metadata.

Phase 9C does not add wildcard permission rules, an OS sandbox, cancellation, timeout, retry, budgets, Verification, CLI, Web UI, or Phase 9D functionality.
