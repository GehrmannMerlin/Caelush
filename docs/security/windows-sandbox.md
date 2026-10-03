# Windows permission sandbox boundary

What the three Windows permission presets actually constrain, and what they deliberately do not.

The backend is `PARTIAL`: it constrains the **write effects** of a command and does not claim to
isolate reads, network, or process visibility. Everything below is either read from the
implementation or measured by the suites named at the end; where a claim is a documented limit it
says so rather than reading as a guarantee.

## Where this sits

```text
Web / CLI          three Chinese choices, one selected value
      ↓
Daemon             WorkspacePreparationPort + exactly one restricted Provider
                   (apps/daemon/src/services/windows-sandbox-host.ts)
      ↓
@caelush/runtime   the only process-execution substrate
                   NativeWorkspaceSandboxController  - workspace ACL authority
                   windows-acl-restricted-token      - Provider id
      ↓
Runner             native/sandbox-runner, one process, one restricted spawn
      ↓
Win32              restricted token + capability-SID ACEs + kill-on-close Job Object
```

Supported: Windows on NTFS. The workspace root and the private temp root are both validated before
use and both must be NTFS-backed directories reachable through a stable file identity.

## Runner entry points

Both workspace preparation and restricted process execution reach the verified Runner; the details
of the daemon-owned Runtime authorization path follow below.

```text
workspace-status / workspace-prepare   invoked by the Daemon       Runner reached
restricted process spawn               authorized by the Daemon    Runner reached
```

## Runtime authorization

| Path                           | Current status                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| workspace status / preparation | Daemon calls the verified Runner                                     |
| restricted process execution   | Daemon resolves an authorized Runtime execution through the provider |
| FULL_ACCESS process execution  | separate unrestricted provider, subject to the persisted policy      |

The daemon composition creates one Windows sandbox host. Its single verified Runner artifact is
used to create both the workspace-preparation controller and the restricted process provider.
SecurityCapabilityService reports provider availability from cached probes and uses those same
probes for provider selection. Before a process Tool runs, the authorization resolver reads the
Run's persisted security policy, maps it to a RuntimeProcessPolicy, selects a provider, and creates
the existing AuthorizedRuntimeExecution. UI preset text is not execution authority. A missing or
incapable provider fails closed; restricted execution is not silently changed to Full Access.

Workspace preparation and process authorization are related but distinct: successful workspace
preparation does not by itself prove every requested process policy is supported. In particular,
READ_ONLY can run only if a provider explicitly supports that stricter policy; it must not be
weakened to WORKSPACE_WRITE. Capability reporting and Runtime provider selection use the same
daemon-owned service and provider set, rather than separate UI and execution registries.

## Runner/workspace separation

The Runner is execution infrastructure; the workspace is the object whose security descriptor is
being changed. Never place the Runner in a workspace that may be prepared:

- the Runner path must not equal or be below the workspace root;
- the workspace must not contain the Runner or its manifest.

Workspace DACL inheritance and the Low mandatory-integrity label apply to descendants. Co-locating
the helper with the target puts part of the control infrastructure inside the security boundary it
is responsible for preparing, potentially affecting its launch, replacement, or control operation.
The invariant is separation, not repeated ACL editing of the Runner.

The development helper currently defaults to
<CAELUSH_HOME>/runtime/sandbox-runner/windows-<arch>/ (or
%USERPROFILE%/.caelush/runtime/sandbox-runner/windows-<arch>/ when CAELUSH_HOME is unset). It
refuses a Runner binary or manifest inside the source repository. Release resolution uses the
fixed application bundle. Both paths retain manifest validation and SHA-256 verification; moving
a development artifact outside the checkout does not weaken artifact verification. The current
development path does not yet include the artifact hash as a directory component.

**Important enforcement gap:** the development helper checks overlap with the source repository,
not with every workspace registered later. The native Runner currently validates the workspace
against the per-Run temp directory, but does not compare the selected workspace with its own
executable or manifest. Arbitrary workspace/Runner overlap is therefore not yet rejected
end-to-end, even though it is a required security invariant. Until that runtime check is
implemented, keep CAELUSH_HOME and the application installation outside every workspace that may
be prepared; do not interpret READY as proof that this overlap was checked.

## Presets

| Preset            | Token                              | Filesystem                                            | Approval                   |
| ----------------- | ---------------------------------- | ----------------------------------------------------- | -------------------------- |
| `VIEW_ONLY`       | Low-integrity, write-restricted    | reads follow the user's own ACLs; no write is granted | normal                     |
| `WORKSPACE_WRITE` | the above plus two capability SIDs | workspace and this Run's private temp are writable    | normal                     |
| `FULL_ACCESS`     | none                               | none - ordinary user rights                           | explicit risk confirmation |

`FULL_ACCESS` is a different code path, not a weaker setting of the same one: it uses the
`unrestricted` Provider and never enters workspace preparation. The two restricted presets never
degrade into it. If the artifact, the token, the ACL, the control channel, or the Job Object cannot
be established, the Run fails closed and no payload is created - the contract asserted by
`windows-sandbox-faults.e2e.test.ts`, which injects a failure at every step of that sequence.

## Token construction

`VIEW_ONLY` creates a token with `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED` and assigns
the Low mandatory integrity label. `WRITE_RESTRICTED` means every write access is re-checked against
the token's restricted SID list, which is why a Low label alone is not what confines writes.

`WORKSPACE_WRITE` adds two capability SIDs to that list:

- the **workspace SID**, derived from a SHA-256 over the canonical workspace root;
- the **temp SID**, derived from the per-Run temp marker id.

Both sit under the `S-1-4` capability authority, so they are not user, group, or logon SIDs and
cannot be produced by an unprivileged process guessing at them. Deriving the workspace SID from the
canonical path is what makes the grant workspace-specific: two workspaces never share one.

## Standing workspace ACE

Preparation (workspace-prepare) manages the workspace DACL and SACL separately:

| Security descriptor | Entry                                       | Mask              | Inheritance        |
| ------------------- | ------------------------------------------- | ----------------- | ------------------ |
| DACL                | allow, workspace capability SID             | FILE_ALL_ACCESS   | object + container |
| DACL                | deny, Everyone                              | FILE_DELETE_CHILD | container          |
| SACL                | mandatory label, Low integrity, no-write-up | -                 | object + container |

Existing user and system entries are preserved; this operation does not change the owner or the
parent directory's ACL, and it does not grant the current user Full Control. Preparation reads the
current DACL and SACL first. If the exact allow ACE, deny ACE, and integrity label are already
present, it returns UNCHANGED without writing. Otherwise it builds the required descriptor
changes, applies the mandatory label (SACL) and DACL as separate Win32 operations, then reads the
security state again and verifies the postcondition before reporting success. The
FILE_DELETE_CHILD deny is what stops the workspace directory itself from being deleted or replaced
through its parent by anything holding delete rights there.

For a first-time label change, the Runner preflights the workspace with
CreateFileW(..., WRITE_OWNER, ...). The caller also needs sufficient access to apply the DACL
change. An inherited Modify grant commonly does not include WRITE_OWNER; in that case preparation
returns the bounded code WINDOWS_WORKSPACE_WRITE_OWNER_REQUIRED, rather than taking ownership,
elevating itself, or widening the user's ACL. Existing owner and ACLs remain untouched.

The writes are phased, not an atomic transaction across the two security-information classes. The
label is written before the DACL so a label-permission failure cannot leave a newly exposed
capability grant. If a later DACL write or postcondition check fails after the label was written,
the security descriptor may be partially prepared; the operation reports failure and never reports
READY. There is no automatic rollback. A later prepare re-reads actual state and may complete the
missing phase if the required permissions are then available.

This ACE is a **standing** grant. It is not created per Run and not removed when a Run ends; a Run
only _inspects_ it and refuses to start with `WINDOWS_WORKSPACE_GRANT_MISSING` if it is absent. It
is removed only by the explicit revoke path, which removes exactly the product's own entry and
leaves any user entry that happens to name the same SID alone. This is why the settings screen
distinguishes "prepared" from "not prepared" rather than presenting preparation as a per-Run effect.

## Per-Run temp ACE and cleanup

The private temp grant is created with the same three-entry shape and is scoped to one Run:

- granted immediately before the payload is created;
- revoked by `RestrictedProcess::wait()` as the Run settles, and on **every** error path in between,
  including a failure while the process is being created or assigned to the Job Object;
- if the spawn itself fails after the grant, the grant is revoked explicitly before the error
  propagates.

The Runner holds the payload in a Job Object configured kill-on-close, so the whole tree - child and
grandchild - dies with the Runner whether the Run ended normally, was cancelled, or the Runner
itself failed after `READY`. The private temp directory is then removed by the Runtime.

Two limits to that cleanup, both pinned by tests rather than left implicit:

- The ownership marker (`.caelush-private-temp.json`) lives **inside** the directory the payload is
  granted `FILE_ALL_ACCESS` on. A payload that deletes or corrupts it makes both the per-Run cleanup and
  the stale sweep refuse, because neither can then verify ownership. The residue is the directory and
  the ACE held by that Run's capability SID - and that SID is derived from a random per-Run marker id, so
  this is unreclaimable litter, not a widening of authority. Pinned by
  `packages/runtime/test/private-temp.test.ts`.
- `cleanupStalePrivateRunTemps` exists and is tested, but **no production path calls it**. A Daemon
  killed hard while a Run is alive therefore leaves the directory and its per-Run ACE behind, and the
  next start does not reclaim them. Wiring the sweep into Daemon startup is a separate task.

## Path validation

Before any ACE is touched, the workspace and temp roots are validated and a failure is refused
rather than repaired:

| Check                                                           | Code                                        |
| --------------------------------------------------------------- | ------------------------------------------- |
| not an absolute path, unreadable, or not a directory            | `WINDOWS_PATH_BOUNDARY_INVALID`             |
| is a reparse point (junction, symlink, any reparse kind)        | `WINDOWS_PATH_BOUNDARY_REPARSE_UNSUPPORTED` |
| resolves to a filesystem root                                   | `WINDOWS_PATH_BOUNDARY_ROOT_UNSUPPORTED`    |
| canonical path or file identity changes between two resolutions | `WINDOWS_PATH_BOUNDARY_IDENTITY_CHANGED`    |
| workspace and temp are equal, identical, or nested              | `WINDOWS_PATH_BOUNDARY_OVERLAP`             |
| the working directory is outside both                           | `WINDOWS_WORKSPACE_CWD_BOUNDARY_INVALID`    |

The reparse check is on the `FILE_ATTRIBUTE_REPARSE_POINT` attribute and runs **before** the
directory test, because `Metadata::is_dir()` is false for a junction or directory symlink - Rust
classifies both as symlinks. Testing directory-ness first answered "invalid path" for exactly the
paths this check exists to name.

Do not treat the operating system's answer as sufficient evidence that a link exists: on the host
these suites run on, `CreateSymbolicLinkW` returns success while materialising an ordinary
directory, so a test that asserted "a symlink was rejected" would have been measuring a plain
directory. Fixtures therefore verify the reparse attribute (or that the path resolves to the
intended target) before asserting anything about it.

## Diagnosis codes

Bounded strings, never a path or a Win32 message:

```text
WINDOWS_CURRENT_TOKEN_OPEN_FAILED     WINDOWS_TOKEN_GROUPS_QUERY_FAILED
WINDOWS_LOGON_SID_MISSING             WINDOWS_KNOWN_SID_CREATE_FAILED
WINDOWS_RESTRICTED_TOKEN_CREATE_FAILED    WINDOWS_RESTRICTED_TOKEN_NULL
WINDOWS_LOW_INTEGRITY_SET_FAILED      WINDOWS_DEFAULT_DACL_CREATE_FAILED
WINDOWS_DEFAULT_DACL_SET_FAILED       WINDOWS_COMMAND_LINE_BUILD_FAILED
WINDOWS_ENVIRONMENT_BUILD_FAILED      WINDOWS_STANDARD_HANDLE_PREPARE_FAILED
WINDOWS_JOB_CREATE_FAILED             WINDOWS_JOB_CONFIGURE_FAILED
WINDOWS_RESTRICTED_PROCESS_CREATE_FAILED    WINDOWS_JOB_ASSIGN_FAILED
WINDOWS_THREAD_RESUME_FAILED          WINDOWS_PROCESS_WAIT_FAILED
WINDOWS_EXIT_CODE_QUERY_FAILED        WINDOWS_SANDBOX_MODE_UNAVAILABLE
WINDOWS_CAPABILITY_SID_INPUT_INVALID  WINDOWS_CAPABILITY_SID_HASH_FAILED
WINDOWS_CAPABILITY_SID_PARSE_FAILED   WINDOWS_PATH_BOUNDARY_INVALID
WINDOWS_PATH_BOUNDARY_OVERLAP         WINDOWS_PATH_BOUNDARY_REPARSE_UNSUPPORTED
WINDOWS_PATH_BOUNDARY_IDENTITY_CHANGED    WINDOWS_PATH_BOUNDARY_ROOT_UNSUPPORTED
WINDOWS_ACL_READ_FAILED               WINDOWS_ACL_SID_FAILED
WINDOWS_ACL_BUILD_FAILED              WINDOWS_ACL_APPLY_FAILED
WINDOWS_DACL_APPLY_FAILED             WINDOWS_INTEGRITY_LABEL_APPLY_FAILED
WINDOWS_WORKSPACE_WRITE_OWNER_REQUIRED
WINDOWS_WORKSPACE_SECURITY_POSTCONDITION_FAILED
WINDOWS_ACL_PATH_LOCK_FAILED          WINDOWS_WORKSPACE_GRANT_MISSING
WINDOWS_WORKSPACE_CWD_BOUNDARY_INVALID
```

Runner artifact failures also use bounded codes such as RUNNER_ARTIFACT_MISSING,
RUNNER_MANIFEST_INVALID, RUNNER_HASH_MISMATCH, and RUNNER_BACKEND_MISSING. These codes are
suitable for diagnosis and localized guidance; native exception text and absolute workspace paths
are not part of the public error.

## Enforcement boundaries

Measured by `packages/runtime/test/windows-sandbox-boundaries.e2e.test.ts`, which requires every
boundary below to carry a classification, so one that stops being measured fails the suite instead
of disappearing from the evidence.

| Boundary                                                      | Verdict                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| reads outside the workspace (VIEW_ONLY)                       | documented partial - no read barrier is added                                        |
| read through a hard link to an outside file                   | documented partial - follows the read boundary                                       |
| write through a hard link to an outside file                  | enforced - the link shares the target's ACL, which grants the capability SID nothing |
| read through a junction to a directory outside the workspace  | documented partial - follows the read boundary                                       |
| write through a junction to a directory outside the workspace | enforced - the grant is on the workspace directory, not on the reparse target        |
| a directory reparse point offered as the workspace root       | rejected during preparation, and a Run against it is refused                         |
| loopback network access from inside the sandbox               | documented partial - no network isolation                                            |
| the sandboxed process in the host process namespace           | documented partial - no process namespace                                            |
| a restricted payload enumerating host processes               | enforced - the restricted token carries no enumeration rights                        |

The last two rows are read together on purpose. The product does not hide processes and never claims
a process namespace: a sandboxed process is an ordinary member of the host's process list. That the
restricted child cannot itself run `tasklist` is a consequence of the token's rights, not an attempt
at hiding, and it is pinned because it is also evidence that the token really is restricted.

## Known hardening backlog and enforcement gaps

These are explicit limits, not guarantees. Runner/workspace overlap is an enforcement gap that
must be closed before arbitrary workspace paths can be treated as protected by this invariant.

| Item                                                                                                                                                  | What it is today                                                                                                | What hardening would need                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CAELUSH_SANDBOX_RUNNER_PATH` / `_MANIFEST` accept any absolute path, and the artifact hash is checked against the manifest sitting beside the binary | a development/diagnostic override; reaching it means controlling the Daemon's own environment (i.e. its launch) | an out-of-band trust anchor (signing) if that environment is ever not trusted     |
| Runner/workspace path separation is not checked for every registered workspace                                                                        | dev startup rejects artifacts inside the checkout; native validation currently checks workspace vs temp only    | reject equality and either containment direction before preparation and execution |
| Development Runner directory does not include its artifact hash                                                                                       | manifest SHA-256 is still verified; the versioned output location may be replaced by a later build              | place each artifact under a platform/arch/hash-specific immutable directory       |
| Validation and the ACE apply are keyed on the path name, not on a held directory handle                                                               | a narrow TOCTOU window; winning it needs write rights on the parent plus timing                                 | holding the handle open from validation through the ACL write                     |
| `sid_is_product_capability` accepts any `S-1-4-*` / `S-1-15-3-*` ACE with the grant's exact mask and inheritance                                      | an unrelated such ACE keeps the shared Low-integrity SACL and Everyone deny after revoke                        | match the product SID list, not the authority prefix                              |
| A legacy two-field `ToolSecurityContext` carries no policy, so its scope ordinary-spawns                                                              | not reachable: the Daemon always derives the three-field context from the persisted policy snapshot             | an explicit "policy-bound" flag on the Runtime scope, not inference from presence |

The last row is characterised by `packages/coding-agent/test/runtime-adapters.test.ts` so the fail-open
is visible in a test rather than assumed safe.

## Not in scope

- Full network isolation, including blocking loopback.
- Hiding other users' processes or providing a process namespace.
- Virtual machines, containers, or the Windows Sandbox product.
- PTY/ConPTY under a restricted preset; `PTY_UNAVAILABLE` is unchanged.
- Mediating reads: a command may read whatever the user running it may read.

For threat-model purposes the backend is a guard against a coding agent's own commands damaging the
host or neighbouring projects. It is not a containment boundary for hostile code, which would need
the network, read, and process controls listed above.

## Evidence

```text
pnpm test:sandbox:windows                                        permission matrix, READ_ONLY + WORKSPACE_WRITE
pnpm exec vitest run packages/runtime/test/windows-sandbox-faults.e2e.test.ts
                                                                 failure closure at all ten spawn stages
pnpm exec vitest run packages/runtime/test/windows-sandbox-boundaries.e2e.test.ts
                                                                 the table above
cd native/sandbox-runner && cargo test --lib                     token, ACL, boundary and process units
cd native/sandbox-runner && cargo test --features test-fault-injection
                                                                 the same units plus the fault seam
```
