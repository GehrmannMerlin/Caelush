# Caelush Desktop & Cloud Interface Freeze

- **Round:** D0-A — Repository Freeze & Regression Baseline
- **Target product:** Caelush Desktop 1.0.0
- **First platform:** Windows x64
- **Future Cloud deployment target:** `43.133.238.148` (not contacted in D0-A)
- **Source baseline audited:** `0ad8ebf48e31c59567dfc8fc25f7c76c78811685` (`main`)
  **Status:** D0-A freezes authority and trust-boundary semantics. Items marked
  `DEFERRED — D0-B CONTRACT DETAIL` are not frozen wire DTOs.

## 1. Scope and observed repository state

D0-A records the boundary for later rounds. It does not add Electron runtime
code, Cloud code, a Daemon Host Token, a profile switcher, credential migration,
or an updater.

At the audited SHA, the root package and every workspace package manifest report
version `0.1.0`. `apps/launcher/src/version.ts` reads the launcher manifest and
exports `PRODUCT_VERSION`; `apps/daemon/src/version.ts` reads the Daemon package
manifest and exports `DAEMON_VERSION`. There is no single Desktop product
version source yet. The repository contains no Cloud workspace. `apps/desktop`
contains a resource directory but no `package.json` or TypeScript `src` tree, so
it is not currently a pnpm workspace project. The pre-existing
`apps/desktop/resources/caelush-app-icon.png` remains unchanged in D0-A.

The current `scripts/build-release.mjs` creates a portable Node.js workspace
archive and takes its release version from the Launcher manifest. It is not an
Electron build or Windows installer pipeline. Product-version unification,
Desktop/Daemon/Web compatibility metadata, and the build graph are D0-B work.

Current Daemon facts used below:

- `apps/daemon/src/config.ts` defaults to host `127.0.0.1` and port `43120`.
  `apps/daemon/src/daemon.ts` requires a loopback host and reports the bound
  address after Fastify listens.
- `apps/daemon/src/transport/local-request-guard.ts` checks loopback `Host` and
  `Origin`. It does not authenticate which local process made the request.
- `GET /api/v1/health` reports `apiVersion: "v1"` and
  `protocolVersion: 1`. `GET /api/v1/info` returns the strict Protocol
  `DaemonInfo` schema, including daemon version and capabilities.
- `apps/daemon/src/product-paths.ts` uses `CAELUSH_HOME` when set and otherwise
  resolves to `<home>/.caelush`; the current default is not the Windows
  `%LOCALAPPDATA%\Caelush` profile layout below.
- The only production composition root remains `apps/daemon`. Desktop will
  supervise and proxy to it; it will not assemble Agent execution services.

## 2. System authorities and data boundaries

| Boundary          | Owns                                                                                                                                                                                                        | Must not own or expose                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Electron Main     | Cloud Account Client; Windows Secure Vault adapter; Profile Manager; Daemon Supervisor; Local Protocol Proxy; Desktop Window lifecycle; Browser Guest lifecycle; Update Coordinator                         | AgentLoop, RunController, model inference implementation, Tool Dispatcher, or an Agent Run state machine                                |
| Electron Renderer | Account/login state presentation; existing React Agent UI; workspace, terminal, and browser panels; update progress                                                                                         | System credentials, Daemon Host Token, arbitrary Node.js APIs, arbitrary filesystem access, generic IPC, or direct Cloud/Daemon secrets |
| Local Daemon      | The sole production Agent composition; Agent Kernel; Run lifecycle and Completion Authority; Runtime and Tool execution; local SQLite; Context and Prompt Surface; Provider Credential resolution; HTTP/SSE | Cloud authentication decisions, Cloud account state in Agent Context, or a second host-owned execution authority                        |
| Caelush Cloud     | Accounts, email verification, devices and login sessions, offline grants, account entitlements, Release/Update Policy, Cloud security audit                                                                 | Caelush Agent packages, local workspace/Session/Message/Run/Tool data, prompts, model traffic, Provider API keys, or local execution    |

The Renderer may use only the named Preload API in §5 and the Main-owned local
protocol path in §3. It must not receive the Daemon Host Token or Cloud access
and refresh tokens. The Main process owns authentication and token operations.

Cloud must not receive workspace files or paths, Sessions, Messages, Runs, Tool
Execution content, model inputs or outputs, Provider API keys, Prompt Cache
content or sensitive fingerprints, local terminal input/output, browser history,
cookies, or page contents. Desktop and Daemon must not add those values to
Cloud requests, crash reports, analytics, or Cloud audit payloads. Cloud
requests are restricted to account/device/session, entitlement, offline-grant,
and update-policy purposes. Any operational telemetry contract is
`DEFERRED — D0-B CONTRACT DETAIL` and must preserve this exclusion list.

## 3. Desktop ↔ Daemon contract

### 3.1 Existing `/api/v1` contract

The current Daemon Protocol namespace remains `/api/v1`. The Desktop adapter
uses the shared `@caelush/client` and `@caelush/protocol` public entry points.
It does not introduce a parallel Run API or translate Agent state into a
Desktop-owned state machine.

| Existing operation                              | Request body                                             | Response                                                                                                                                            | Existing format and compatibility behavior                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`                            | None                                                     | `HealthResponse`: service, ready status, API version, Protocol version                                                                              | Strict JSON schema; health must pass before info is read                                                                                                                                                               |
| `GET /api/v1/info`                              | None                                                     | `DaemonInfo`: API/Protocol/Daemon versions, capabilities, runtime kinds, configured provider IDs, optional default model, default Run configuration | Strict JSON schema. The current Protocol version is `1`; the capability set includes Run execution/recovery, cancellation, approvals and SSE replay, with additive optional capabilities including `sessionTranscript` |
| Existing Session and Run routes under `/api/v1` | Existing `@caelush/protocol` request schemas             | Existing Protocol response schemas                                                                                                                  | Preserve status codes, JSON-safe bodies, typed errors and existing route semantics                                                                                                                                     |
| `GET /api/v1/runs/{runId}/events`               | No body; `afterSequence` query or `Last-Event-ID` header | `text/event-stream` of public RunEvents                                                                                                             | Durable events carry `id` equal to their sequence; ephemeral events carry no id. If both cursors are supplied they must agree                                                                                          |

`@caelush/client` already provides the HTTP/SSE client. Web defaults to its
current origin; CLI uses `CAELUSH_DAEMON_URL` or
`http://127.0.0.1:43120`. Both hosts validate Daemon health/info and existing
Protocol versions. Session Transcript requires the `sessionTranscript`
capability; absence is a protocol compatibility error, not a client-side
hydration fallback.

### 3.2 Frozen Desktop host semantics

The following are the D0-A host contract. They freeze identity, ownership, and
failure behavior; they do not implement startup authentication or add fields to
the existing Protocol schema.

| Protocol operation                                | Request                                                                                                                                                                                                        | Response                                                                                                                           | Authentication                                                                                                                                             | Data format                                                                      | Error semantics                                                                                                                                                      | Production authority                                                                              | Planned round                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| Start a Desktop Daemon for a Profile              | Main launches a private child process and selects one immutable Profile data root. Exact bootstrap message fields and IPC transport: `DEFERRED — D0-B CONTRACT DETAIL`; validate the Windows transport in D0-C | Child identity, readiness, and bound loopback address returned over the private startup channel; exact DTO deferred                | Child identity must be proven by the Main-created process/IPC channel. A Daemon found on the ordinary CLI/Web port is not proof                            | Private process IPC; wire schema deferred                                        | Startup timeout, child exit, invalid bootstrap, or incompatible version fails closed and leaves the Profile unselected                                               | Desktop Main owns supervision; the Daemon remains the only Agent composition root                 | D3-A, D4-A; transport POC in D0-C |
| One-time bootstrap                                | Main creates a cryptographically random, single-use bootstrap secret and sends it only on the private child channel                                                                                            | Daemon accepts it once and establishes a process-generation Host Token; exact challenge/message schema deferred                    | Only the child and its trusted Main may see the secret. Never use Renderer IPC, public HTTP, command-line arguments, logs, or persistent storage           | Private IPC; exact encoding deferred                                             | Missing, replayed, mismatched, or expired bootstrap fails closed; no unauthenticated Desktop-managed fallback                                                        | Main/Daemon private channel                                                                       | D4-A                              |
| Bind a Desktop Daemon                             | OS assigns an available random loopback port by binding port `0`; bind address must be loopback                                                                                                                | Actual address is returned only to Main; exact representation deferred                                                             | Host Token required for the Desktop-managed listener                                                                                                       | Loopback HTTP carrying the existing `/api/v1` protocol                           | Bind failure or non-loopback address aborts startup                                                                                                                  | Daemon binds; Main verifies child identity and address                                            | D0-C POC, D4-A                    |
| `GET /api/v1/health` and `/api/v1/info` handshake | Main-owned proxy sends existing health/info requests after process startup                                                                                                                                     | Existing schemas; Desktop checks `apiVersion`, `protocolVersion`, `daemonVersion`, and every capability required by the bundled UI | Desktop Host Token required on the Desktop-managed HTTP listener, including health/info. Exact header and handshake DTO: `DEFERRED — D0-B CONTRACT DETAIL` | Existing JSON schemas                                                            | Invalid schema, missing required capability, API/Protocol mismatch, or incompatible product pair yields `PROTOCOL_INCOMPATIBLE`; no fallback to an unverified Daemon | Protocol owns DTO; Daemon owns actual version/capability values; Main owns compatibility decision | D0-B; D4-A                        |
| Profile ↔ Daemon binding                          | Main starts exactly one Desktop-managed Daemon generation for the selected Profile root                                                                                                                        | The Main records process identity, Profile identity, port, and generation in memory; exact record DTO deferred                     | Host Token is scoped to that process generation and Profile                                                                                                | Private Main state; no Renderer serialization of token                           | A process that cannot be tied to the selected Profile is rejected                                                                                                    | Profile Manager and Daemon Supervisor in Main                                                     | D4-A                              |
| Ordinary HTTP request proxy                       | Existing `/api/v1/**` path, method, query, body, and abort signal through the Main-owned proxy                                                                                                                 | Daemon response status, content type, and body, subject to safe hop-by-hop header handling                                         | Main injects the Host Token; Renderer never receives it                                                                                                    | Existing JSON request/response contracts; no arbitrary URL or network forwarding | Preserve typed Daemon errors; proxy failure becomes a bounded transport error with no token or exception leakage                                                     | Existing Daemon route remains authoritative                                                       | D4-B                              |
| SSE request proxy                                 | Existing `GET /api/v1/runs/{runId}/events`, query cursor, and reconnect request                                                                                                                                | Streaming public RunEvents                                                                                                         | Main injects Host Token for the stream lifetime                                                                                                            | `text/event-stream`; do not buffer the stream as JSON                            | Preserve terminal errors and stream closure; aborting the Renderer request aborts the upstream request and Daemon subscription                                       | Daemon RunEventHub and public projector remain authoritative                                      | D4-B                              |
| SSE cursor and reconnect                          | Preserve `Last-Event-ID` and/or existing `afterSequence`; reject conflicting cursor values as the Daemon does                                                                                                  | Replay begins strictly after the durable cursor; live events continue after the fixed replay high-water mark                       | Host Token on each reconnect; token generation must still be current                                                                                       | Durable SSE id is the decimal sequence; ephemeral SSE events have no id          | A cursor ahead of the Daemon high-water mark or malformed cursor returns the existing typed cursor error; reconnect uses the last processed durable sequence         | Storage durable reader + Daemon RunEventHub; Web/CLI presentation reconnect schedulers            | D4-B                              |
| Request cancellation                              | Abort/cancel the Renderer request through the Main proxy                                                                                                                                                       | Upstream request and, for SSE, subscription are closed                                                                             | Host Token remains process-local during teardown                                                                                                           | Abort signal and transport close                                                 | Cancellation is propagated; it does not create a Run state transition by itself                                                                                      | Existing Client, Daemon route and RunController                                                   | D4-B                              |
| Legacy CLI/Web connection                         | Existing environment/default discovery path and existing `/api/v1` client behavior                                                                                                                             | Existing health/info and Session/Run results                                                                                       | Existing ordinary local Daemon boundary; no Desktop Host Token requirement is added to this mode                                                           | Existing JSON/SSE                                                                | Existing compatibility and reconnect errors remain                                                                                                                   | CLI/Web remain thin clients; ordinary Daemon semantics remain unchanged                           | D0-A compatibility invariant      |

### 3.3 Host Token lifecycle and compatibility boundary

- Desktop must never reuse an ordinary Daemon merely because `/health` responds
  on a familiar port. The child must be the process started for the selected
  Profile and must complete the private bootstrap.
- A Desktop-managed Daemon requires a valid Host Token on every proxied HTTP and
  SSE request. The ordinary CLI/Web Daemon keeps its existing behavior. The
  future mode distinction and listener enforcement belong to D4-A.
- The one-time bootstrap secret is consumed once. The resulting Host Token is
  unique to one Daemon process generation, held only by trusted Main/Daemon
  code, and invalidated on process exit or restart. A restart requires a new
  bootstrap and token.
- The Main-owned Local Protocol Proxy may forward only the Daemon API origin and
  `/api/v1` routes. It reconstructs safe headers and strips hop-by-hop headers;
  it cannot become a general HTTP client or arbitrary network proxy.
- The Renderer-to-proxy transport mechanism and exact Host Token header are
  `DEFERRED — D0-B CONTRACT DETAIL`; Windows pipe/IPC and Electron behavior must
  be validated in D0-C. The semantic requirement is fixed: the Renderer never
  knows the Daemon port/token and cannot bypass Main authentication.
- Daemon version and capabilities are checked before the UI becomes ready. The
  required Desktop/Daemon/Web compatibility matrix and version source are
  `DEFERRED — D0-B CONTRACT DETAIL`.
- The Daemon never contacts Cloud to decide whether to execute an Agent Run.
  Cloud account identity, email, device identifiers, entitlement state, and
  Offline Grant timestamps are not added to Agent Context, Prompt Surface,
  durable messages, RunEvents, or Provider requests.

## 4. Desktop ↔ Cloud API contract

Cloud uses the independent `/v1` namespace. It is not a Daemon API prefix, and
the Daemon does not proxy Agent content to it. Production requests use HTTPS and
UTF-8 JSON. All timestamps are RFC 3339 UTC; user, device, and Session IDs are
UUIDs. Every successful response contains `requestId`. Error responses use
stable public error codes, never database exceptions or internal stack traces.
Authentication failures must not reveal whether an account exists.

The routes and their purposes are frozen below. DTO fields, exact status codes,
pagination, rate limits, idempotency, and retry fields are not specified here;
each remains `DEFERRED — D0-B CONTRACT DETAIL` until the Cloud OpenAPI contract
is designed and reviewed.

| Method and path                         | Request body                              | Successful response                                            | Authentication                                | Error behavior                                              | Authority            | Round |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- | -------------------- | ----- |
| `POST /v1/auth/register`                | Registration DTO — deferred               | `requestId` plus verification-pending result — fields deferred | No existing Access Token                      | Generic non-enumerating account response; stable code       | Cloud Auth           | D1-A  |
| `POST /v1/auth/verify-email`            | Verification DTO — deferred               | `requestId` plus account/session result — fields deferred      | Verification proof; representation deferred   | Stable code; no account enumeration                         | Cloud Auth           | D1-A  |
| `POST /v1/auth/resend-verification`     | Resend DTO — deferred                     | `requestId` plus generic accepted result                       | No Access Token requirement frozen            | Same public result for known/unknown addresses              | Cloud Auth           | D1-A  |
| `POST /v1/auth/login`                   | Login DTO — deferred                      | `requestId` and auth lifecycle result — fields deferred        | No existing Access Token                      | Generic non-enumerating failure                             | Cloud Auth           | D1-A  |
| `POST /v1/auth/refresh`                 | Refresh DTO — deferred                    | `requestId` and rotated auth result — fields deferred          | Refresh proof; exact placement deferred       | Stable code; revoke/rotation semantics D2-A                 | Cloud Auth           | D2-A  |
| `POST /v1/auth/logout`                  | Logout DTO — deferred                     | `requestId` and logout result                                  | Auth/session proof — exact mechanism deferred | Stable code; idempotency deferred                           | Cloud Auth           | D2-A  |
| `POST /v1/auth/forgot-password`         | Recovery DTO — deferred                   | `requestId` and generic accepted result                        | No Access Token                               | Same public result for known/unknown addresses              | Cloud Auth           | D1-B  |
| `POST /v1/auth/reset-password`          | Reset DTO — deferred                      | `requestId` and result                                         | Reset proof; representation deferred          | Stable code; no account enumeration                         | Cloud Auth           | D1-B  |
| `POST /v1/auth/change-password`         | Password-change DTO — deferred            | `requestId` and result                                         | Auth/session proof — exact mechanism deferred | Stable code; never return internal password-provider errors | Cloud Auth           | D1-B  |
| `GET /v1/account/me`                    | None                                      | `requestId` plus account projection — fields deferred          | Access Token in Bearer form                   | Stable unauthorized/forbidden code                          | Cloud Account        | D1-A  |
| `GET /v1/account/devices`               | None; pagination deferred                 | `requestId` plus device projections — fields deferred          | Access Token in Bearer form                   | Stable code; no other account data                          | Cloud Device Session | D2-A  |
| `DELETE /v1/account/devices/{deviceId}` | None unless later OpenAPI requires a body | `requestId` plus revocation result                             | Access Token in Bearer form                   | Stable code; account/device ownership is enforced in Cloud  | Cloud Device Session | D2-A  |
| `GET /v1/desktop/update-policy`         | Query/platform fields deferred            | `requestId` plus signed policy projection — fields deferred    | Exact public/authenticated policy deferred    | Stable code; no internal release-store errors               | Cloud Release Policy | D7-A  |

### 4.1 Authentication lifecycle

| Credential    | Frozen lifetime/constraint                        | D0-A storage or use boundary                                                |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Access Token  | 15 minutes                                        | Sent to Cloud as `Authorization: Bearer`; Main only, not Renderer or Daemon |
| Refresh Token | 30-day sliding lifetime; 90-day absolute lifetime | Windows Secure Vault; exact rotation and replay contract is D2-A            |
| Offline Grant | Up to 15 days, device-bound, Ed25519-signed       | Windows Secure Vault; exact claims, revocation and clock behavior are D2-B  |

The Cloud signing private key must remain a Cloud secret and is never shipped to
Desktop. Signature verification keys may be public application trust material;
their rotation and pinning policy remains for D2-B/D7-A. The Daemon does not
validate account tokens or call Cloud during Agent execution.

## 5. Desktop Preload IPC contract

The Renderer-facing namespace set is closed to `account`, `window`, `workspace`,
`browser`, and `update`. Every method has a separate input and output schema.
The names below are the frozen V1 capability inventory; DTO field shapes are
deferred when no source design currently defines them.

| Namespace   | Methods                                                                                                      | Schema and state boundary                                                                                                                                                                                                                                                           | Planned owner/round                              |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `account`   | `getState`, `register`, `login`, `logout`, `resendVerification`, `refreshNow`, `listDevices`, `revokeDevice` | Each call gets its own strict schema. Return safe account state and operation results only; never return Access/Refresh Tokens, device private keys, or Offline Grant signing material. Auth state controls which calls are accepted. DTO fields: `DEFERRED — D0-B CONTRACT DETAIL` | Main Account Client; D3-B, with Cloud APIs D1/D2 |
| `window`    | `minimize`, `maximizeOrRestore`, `close`, `getPlatform`                                                      | No arbitrary window IDs or Electron objects; current window/state is resolved by Main. Inputs and result DTOs deferred                                                                                                                                                              | Main Window lifecycle; D3-A                      |
| `workspace` | `chooseDirectory`, `openInEditor`, `listEditors`                                                             | Selection/open operations are bounded to explicit user action and current workspace policy. No arbitrary file read/write API or shell. Path/editor DTO details deferred                                                                                                             | Main adapter; D5-A/D5-C                          |
| `browser`   | `createLease`, `navigate`, `goBack`, `goForward`, `reload`, `closeLease`                                     | Calls operate on an opaque Browser Guest lease owned by Main; no raw WebContents, cookies, history, or page DOM is returned to Cloud. URL policy and DTO fields deferred                                                                                                            | Main Browser Guest lifecycle; D5-B               |
| `update`    | `getState`, `check`, `download`, `install`                                                                   | State is a bounded progress/result projection. Download/install accept no arbitrary URL or file path. Install is allowed only for the verified manifest/artifact pair. DTO fields deferred                                                                                          | Main Update Coordinator; D7-A/D7-B               |

IPC enforcement rules:

1. Main validates the sender/frame origin, method arguments, schema, and current
   lifecycle state on every invocation.
2. Do not expose `invoke(channel, payload)`, arbitrary channel names, raw
   Electron/Node objects, arbitrary Shell execution, arbitrary filesystem
   read/write, or arbitrary network requests.
3. Do not return Cloud Access/Refresh Tokens, the Daemon Host Token, Windows
   Vault objects, SQLite/ORM objects, or provider secrets.
4. The Renderer uses a small typed API. A caller cannot choose a Daemon port,
   Profile root, Host Token, release URL, or installer path.
5. Exact origin-validation mechanism and per-method wire DTOs are
   `DEFERRED — D0-B CONTRACT DETAIL`; the least-privilege rules above are fixed.

## 6. Profile and Secure Vault boundaries

Target Windows data layout:

```text
%LOCALAPPDATA%\Caelush\
    profiles\
        <opaque-user-id>\
            caelush.db
            backups\
            logs\
            runs\
            browser\
            downloads\
            profile.json
    shared\
        logs\
        updates\
        migration\
```

| Concern           | Frozen contract                                                                                                                                                                       | Implementation round |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Profile identity  | One Cloud `user_id` maps to one local Profile. Never use email as a directory name. The opaque identifier is an ownership key, not a prompt field                                     | D4-A                 |
| Storage isolation | Each account Profile has an independent SQLite file and Daemon root. The Renderer cannot change the root or move a Daemon between Profiles                                            | D4-A                 |
| Daemon binding    | The selected Profile is fixed for one Daemon generation. Switching account/Profile requires Main to stop/drain that generation and start a new one; detailed sign-out policy deferred | D4-A                 |
| System secrets    | Refresh Token, device private key, and Offline Grant use Windows system credential storage. Renderer receives safe state/masked values only                                           | D2-B                 |
| Provider API Keys | Long-term destination is Windows Secure Vault, with Daemon resolution through a host adapter. Renderer sees configured/masked status only                                             | D4-C                 |
| Legacy import     | Importing existing `~/.caelush` or `CAELUSH_HOME` data requires explicit user confirmation. Migration is staged and backed up; failure retains original data and backup               | D4-D                 |
| Data protection   | Encryption-at-rest, backup retention, profile deletion, and recovery UX require a reviewed Windows design; do not infer guarantees from the current SQLite file                       | D4-C/D4-D            |

**Current-source risk — `MIGRATION REQUIRED — D4-C`:**
`ai_provider_credentials.secret_value` still stores the Provider API Key body in
the local SQLite database as text. `SqliteProviderCredentialRepository`
resolves that value for Daemon model calls; `RuntimeProviderCredentialAuthority`
checks environment credentials first and then resolves the repository value.
This D0-A task does not change its schema, repository, or runtime behavior.

Current `resolveProductPaths()` uses `CAELUSH_HOME` or `<home>/.caelush`, and
Storage applies published Drizzle migrations plus Message V2 and Run-security
finalizers on opening. The Profile layout and migration runner must be added
without bypassing those existing migrations. Exact profile metadata schema and
migration transaction protocol are `DEFERRED — D0-B CONTRACT DETAIL` and
D4-D.

## 7. Version and update trust boundary

| Setting                              | D0-A value or rule                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Target Desktop product version       | `1.0.0`                                                                                                                         |
| Current repository/workspace version | `0.1.0` at audited Base SHA                                                                                                     |
| First platform                       | Windows x64                                                                                                                     |
| Release channels                     | `dev`, `beta`, `stable`                                                                                                         |
| Version scheme                       | SemVer                                                                                                                          |
| Cloud deployment                     | Independent from Desktop/Daemon release deployment                                                                              |
| Local Agent changes                  | Delivered as a new verified Desktop software artifact containing a compatible Daemon/Web build; no Cloud-hosted Agent execution |
| Downgrade                            | Denied by default; any recovery exception must be explicitly designed and signed                                                |

The current Launcher and Daemon read versions from separate package manifests;
the release builder reads the Launcher version. Product version source,
Desktop/Daemon/Web compatibility matrix, and actual capability negotiation are
`DEFERRED — D0-B CONTRACT DETAIL`.

Update trust requires all three checks before install:

1. Verify the Cloud Update Policy Ed25519 signature and reject a policy revision
   lower than the highest accepted revision.
2. Verify the downloaded artifact SHA-512 against the policy/Updater Manifest.
3. Verify Windows Authenticode signer and signature against the release trust
   policy.

The policy and Updater Manifest must identify the same product, channel,
version, platform, architecture, revision, and artifact digest. Download hosts
are constrained by a release-domain allowlist. An unverified or mismatched file
is never passed to an installer. Forced update waits for Core's safe durable
boundary; it cannot abandon in-flight Tool effects, bypass Run checkpointing,
or write `COMPLETED` itself. Exact canonical JSON, policy/manifest fields,
signer rotation and version-comparison implementation are D0-B/D7 work; D0-A
does not implement them.

## 8. Cross-language contract evolution

- Public cross-process and Cloud contracts contain JSON-safe data only. They do
  not expose TypeScript classes, ORM/database instances, Node/Electron objects,
  Provider SDK types, Runtime objects, or Agent internals.
- Cloud publishes a versioned OpenAPI contract from its independent Python /
  FastAPI repository. Desktop consumes only that public contract; it does not
  import Cloud implementation modules.
- Compatible additions are additive and optional where appropriate. Removing,
  reinterpreting, or making an established field incompatible requires a new
  protocol/API major version rather than a silent change.
- Cloud OpenAPI snapshots and client/server compatibility checks are required
  in the Cloud repository. D1-A acceptance must verify no Agent package or
  internal Agent source is imported by Cloud.
- Ed25519-signed payloads need fixed cross-language Python/TypeScript test
  vectors for canonical bytes, signature, valid/invalid inputs, and key rotation.
- Cloud OpenAPI, SDK generation, canonical JSON, and test vectors are
  `DEFERRED — D0-B CONTRACT DETAIL`; no Python service or generated SDK is part
  of D0-A.

## 9. Deferred Implementation Map

| Round     | Sole primary responsibility                                         |
| --------- | ------------------------------------------------------------------- |
| D0-B      | Version source, protocol detail, Desktop capability, build graph    |
| D0-C      | Windows Electron/Node/SQLite/PTY/SSE technical POC                  |
| D1-A–D1-C | Cloud identity/authentication foundation                            |
| D2-A–D2-B | Devices, refresh, and offline authorization                         |
| D3-A–D3-B | Electron shell, Preload, login state machine                        |
| D4-A–D4-D | Profile, Host Token, proxy, Provider Key, and legacy-data migration |
| D5-A–D5-C | Right panel, files, terminal, browser, and editor                   |
| D6-A–D6-B | Windows installer and upgrade compatibility                         |
| D7-A–D7-C | Cloud release policy and Desktop auto-update                        |
| D8-A–D8-B | Production deployment, security acceptance, and stable release      |

D0-A ends at the documented boundary, static architecture rule, and regression
baseline. None of the deferred runtime features is implemented in this round.

---

## D0-B Contract Addendum

- **Round:** Caelush Desktop & Cloud — D0-B
- **Source baseline:** `e263e601ac8b974662b881eb85b5b5f575260069`
- **Current product/workspace version:** `0.1.0`
- **Target stable product version:** `1.0.0`, only after D8-B
- **Daemon API / Protocol:** `/api/v1`, version `v1` / integer `1`

This addendum resolves D0-A's `DEFERRED — D0-B CONTRACT DETAIL` markers only
for the version, compatibility, Cloud API, signed update policy, and build
contract sections below. It freezes data and failure semantics; it does not
implement future Electron, Cloud, Host Token, Profile, or updater runtime
behavior. The prior D0-A regression baseline remains unchanged.

The source audit found no separate complete Desktop/Cloud design package in
this repository. The contract is based on the D0-A freeze plus explicit D0-B
product decisions. The contract-first choices and fields that were not
specified by an earlier design are marked as such in the OpenAPI document and
must be reviewed in the owning implementation round; they are not represented
as already-running Cloud behavior.

### Desktop ↔ Daemon compatibility

The existing production Daemon continues to be the sole Agent composition
root. Its `/api/v1/health` and `/api/v1/info` contracts report API `v1` and
Protocol `1`. `DaemonInfoSchema` remains strict. Its existing required
capabilities retain their meanings; the three Desktop capabilities below are
optional declarations and do not authorize behavior by themselves.

| Capability                | Meaning when implemented                                                      | Production status at D0-B       |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| `desktopHostAuthV1`       | Desktop Main authenticates the owned Daemon process for the active generation | Not implemented; not advertised |
| `desktopProfileBindingV1` | Daemon is bound to one selected opaque Profile for its process lifetime       | Not implemented; not advertised |
| `desktopLocalProxyV1`     | Desktop-only local proxy and request authorization are active                 | Not implemented; not advertised |

The client compatibility evaluator requires:

1. A valid strict `DaemonInfo` payload.
2. Exact API `v1` and Protocol `1`.
3. Exact full SemVer product string equality between Desktop and Daemon for
   the first controlled release tuple.
4. The trusted Main's verified host-identity result.
5. All required capabilities. Missing optional capabilities are returned as
   unavailable and can only disable their dependent feature.

Unknown or malformed fields, unsupported versions, missing required
capabilities, or unverified host identity fail closed. A Desktop capability
listed as required is rejected while it remains absent from the evaluator's
implemented capability set, even if a Daemon were to claim it. The current
implemented set is empty. The evaluator contains no process, network, Cloud,
filesystem, Provider, Run, or Agent operation. See
[`product-version-and-compatibility.md`](./product-version-and-compatibility.md)
for the first release matrix.

The schema extension is optional and strict, not `passthrough`. Existing
production Daemon composition does not add any Desktop field, which preserves
older strict Web/CLI clients. Ordinary Web/CLI continue their existing Health
then Info handshake. Ordinary Launcher reuse, version checks, and external
Daemon warning behavior are unchanged. Desktop must never use ordinary Daemon
reuse as evidence of authenticated Profile ownership.

### Desktop private startup messages

The following logical messages define the D0-B contract shape. The exact
Windows Pipe/IPC transport is D0-C work. The executable implementation of
one-time bootstrap, Host Token, Profile binding, and proxy authorization is
D4 work.

| Message                 | Direction                    | Required logical fields                                                                                                                                                                                            | Failure behavior                                                                                                     |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `START_DESKTOP_DAEMON`  | Main → private child channel | `ipcProtocolVersion: 1`, unpredictable `generationId`, opaque `profileId`, `desktopVersion`, `expectedDaemonVersion`, `apiVersion: "v1"`, `protocolVersion: 1`, `requiredCapabilities`, one-time `bootstrapSecret` | Invalid schema, expired/consumed secret, or generation mismatch fails startup; do not retry with an ordinary Daemon  |
| `DAEMON_READY`          | Child → Main private channel | matching `generationId`, child identity evidence, `daemonVersion`, `apiVersion`, `protocolVersion`, selected ephemeral loopback port, actual capability set, bootstrap acceptance                                  | Reject if identity evidence, generation, port, versions, or requirements do not validate                             |
| `DAEMON_STARTUP_FAILED` | Child → Main private channel | matching `generationId`, stable safe failure code                                                                                                                                                                  | Main returns a safe state; no exception, path, token, or secret is exposed to Renderer                               |
| `STOP_DESKTOP_DAEMON`   | Main → private child channel | matching `generationId`, bounded shutdown request                                                                                                                                                                  | Main waits only for the configured shutdown budget, then invalidates the generation and terminates the owned process |

The bootstrap secret is high entropy, single use, scoped to one process
generation, and short lived. It is carried only on the trusted private
Main/child channel. It must never appear in process arguments, environment
variables, logs, Renderer/preload state, LocalStorage, a URL, Daemon HTTP
payloads, or Cloud API requests. Its generation is discarded after acceptance
or failure. The exact encoding, process evidence, IPC transport, timeout
hardening, and Windows ownership checks are D0-C details.

`DAEMON_READY` reports an OS-assigned ephemeral port bound only to IPv4
loopback (`127.0.0.1`). Desktop does not select a predictable shared port, bind
to all interfaces, or expose the port to Renderer. A Main-to-Daemon Health/Info
handshake must verify the same API, Protocol, exact product version, required
capabilities, process generation, and Host Token before the workspace becomes
available. The existing Launcher startup budget is 10 seconds; Desktop's
initial readiness budget is also 10 seconds, followed by a bounded shutdown
budget that D0-C must validate on Windows. A timeout fails closed.

The Host Token is scoped to the owned Daemon process generation and is
invalidated on exit, restart, Profile switch, or failed binding. A restarted
Daemon receives a new bootstrap and new Host Token; stale messages, tokens, and
proxy requests from an earlier generation are rejected. D4 determines and
implements token construction, rotation, in-memory custody, and request
verification. Only trusted Main/Daemon code may hold the token. Main attaches
it to allowed proxied `/api/v1` requests as `X-Caelush-Host-Token`; it does not
forward Renderer-supplied authorization headers. Health/Info is not a bypass
around owned-process verification.

The Local Protocol Proxy preserves the existing Daemon request body and
response semantics, SSE frames, durable `Last-Event-ID`, cancellation, and
reconnection behavior. It only forwards the allowlisted Daemon API origin and
routes; it strips hop-by-hop headers and rejects arbitrary target URLs. The
Daemon remains the authority for Sessions, Runs, Tools, Runtime, SQLite,
Context, Provider credentials, and RunEvents. Cloud identity, email, device,
offline grant, update, and Desktop UI/panel fields are excluded from DaemonInfo,
Daemon route payloads, Agent Context, Prompt Surface, Security Prompt, and
Prompt Cache fingerprints.

### Desktop ↔ Cloud OpenAPI V1

The contract-first OpenAPI 3.1 document is
[`cloud-api-v1.openapi.json`](./cloud-api-v1.openapi.json). It defines the
frozen 13-operation surface:

| Area                   | Operations                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Registration and login | `POST /v1/auth/register`, `/verify-email`, `/resend-verification`, `/login`, `/refresh`, `/logout` |
| Password recovery      | `POST /v1/auth/forgot-password`, `/reset-password`, `/change-password`                             |
| Account and devices    | `GET /v1/account/me`, `GET /v1/account/devices`, `DELETE /v1/account/devices/{deviceId}`           |
| Desktop update policy  | `GET /v1/desktop/update-policy`                                                                    |

Successful response bodies include a UUID `requestId`. Errors use a stable
`CloudError` code, safe bounded message, retryability flag, and `requestId`;
database exceptions and stack traces are never response data. Inputs and
outputs are UTF-8 JSON; all timestamps are RFC 3339 UTC; identities are UUIDs.
Production Cloud requests use HTTPS and access tokens use the Bearer header.
Registration, verification resend, and password-recovery responses do not
reveal whether an email address is registered or verified. Refresh tokens are
rotated in the JSON body, never in a URL, and replay revokes the token family.

| Credential / grant | Frozen lifetime                                     |
| ------------------ | --------------------------------------------------- |
| Access Token       | 15 minutes                                          |
| Refresh Token      | 30-day sliding lifetime, capped at 90 days absolute |
| Offline Grant      | Up to 15 days, bound to a device, Ed25519 signed    |

Desktop Main is the Cloud credential boundary. Access and Refresh Tokens never
go to Renderer or Local Daemon. The Daemon does not contact Cloud to decide
whether a local Agent action may execute. Cloud receives no workspace files or
paths, Sessions, Messages, Runs, Tool data, model prompts/outputs, Provider
keys, Prompt Cache material/fingerprints, terminal I/O, or browser history,
cookies, or page content. The API intentionally defines no Agent execution,
chat synchronization, file upload, or prompt telemetry route.

The OpenAPI document is a contract-first D0-B design, not output generated by
or proof of a running FastAPI service. Fields that were not specified by an
earlier source design are called out in the OpenAPI descriptions and remain
subject to owner review during D1/D2 implementation. D1-A–D1-C own Cloud auth;
D2-A–D2-B own device, refresh-session, and offline-grant implementation. The
compatibility checker rejects endpoint/method removal, contract semantics or
authentication changes, request additions that become required, response
field/status removal, type/constraint changes, and real schema regressions.
Schema or OpenAPI changes outside its analyzed subset report
`UNDETERMINED` and require manual compatibility review; they are not treated as
automatic PASS.

### Preload, Profile, and Vault

The D0-A Preload namespace allowlist remains exactly `account`, `window`,
`workspace`, `browser`, and `update`, with one schema per method. There is no
generic invoke, arbitrary Shell, arbitrary path read/write, arbitrary network
request, raw Cloud token return, or Electron/Node object exposure. Per-method
DTO refinements and sender/state validation are D3-A–D3-B work.

The Windows profile root, opaque account directory, independent SQLite,
system-vault requirements, legacy-import confirmation, and migration backup
rules remain as frozen in D0-A. The existing
`ai_provider_credentials.secret_value` stores Provider API Key plaintext in
SQLite and remains `MIGRATION REQUIRED — D4-C`. No Schema, key store, or
credential authority runtime change occurs in D0-B.

### Version and update trust

The canonical product-version and first Desktop/Daemon/Web compatibility
matrix is in
[`product-version-and-compatibility.md`](./product-version-and-compatibility.md).
`0.1.0` remains current; `1.0.0` is a target only after D8-B. Channels are
`dev`, `beta`, and `stable`. Protocol/API versions evolve independently from
product SemVer.

The signed policy fields, constrained JCS bytes, Ed25519 key selection,
SemVer/channel checks, revision monotonicity, allowed release host, and
artifact verification order are in
[`signed-update-policy-contract.md`](./signed-update-policy-contract.md).
The trust order is signed Cloud policy, exact artifact size/SHA-512 and
manifest binding, then Windows Authenticode publisher verification. Cloud
policy revisions cannot roll back. The Cloud policy and Updater Manifest must
refer to one artifact. An unverified download is never sent to an installer,
and mandatory updates wait for Core's safe durable boundary. D0-B has no
production signer, updater, downloader, version-changing release pipeline, or
Authenticode implementation.

### Build graph

[`desktop-build-graph.md`](./desktop-build-graph.md) distinguishes the
existing portable Node archive from the not-yet-implemented Electron installer
and supplies the D0-C Windows POC checklist. Node/SQLite/PTY/Sandbox ABI and
Electron resource staging are not claimed as verified by the D0-B documents or
unit tests.

### Deferred Implementation Map

| Round     | Sole primary responsibility                                        | D0-B status                                                                                                                       |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| D0-B      | Version source, protocol detail, Desktop capability, build graph   | Contract and static checks frozen; runtime features deferred                                                                      |
| D0-C      | Windows Electron/Node/SQLite/PTY/SSE technical POC                 | Must prove clean Windows x64 launch, runtime/native compatibility, SSE and process lifecycle                                      |
| D1-A–D1-C | Cloud identity/authentication foundation                           | Implement the OpenAPI auth surface in the independent Cloud repository; add contract compatibility tests                          |
| D2-A–D2-B | Devices, Refresh and offline authorization                         | Implement UUID device/session ownership, token rotation/replay handling, and device-bound signed grants                           |
| D3-A–D3-B | Electron shell, Preload, login state machine                       | Implement the frozen five Preload namespaces and per-method DTO/sender/state checks                                               |
| D4-A–D4-D | Profile, Host Token, proxy, Provider Key and legacy data migration | Implement private bootstrap/Host Token/process generation, profile isolation, proxy, Key migration and backup-safe import         |
| D5-A–D5-C | Right panel, files, terminal, browser and editor                   | Renderer features through the reviewed Main APIs and existing Daemon authority                                                    |
| D6-A–D6-B | Windows install and upgrade compatibility                          | Implement Desktop Resource Manifest, native resource staging, signed installer and migration-safe upgrades                        |
| D7-A–D7-C | Cloud release policy and Desktop auto-update                       | Implement signer custody/rotation, policy-manifest-artifact matching, download, integrity, Authenticode and safe install boundary |
| D8-A–D8-B | Production deployment, security acceptance and stable release      | Deploy Cloud, complete independent security acceptance, and only then claim stable `1.0.0`                                        |

No D0-C or later implementation is performed by this addendum.
