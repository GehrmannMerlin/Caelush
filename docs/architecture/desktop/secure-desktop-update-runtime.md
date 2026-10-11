# Secure Desktop Update Runtime — D7-2

## Ownership and policy

Electron Main owns one `DesktopUpdateCoordinator`. It queries the public D7-1
`GET /v1/desktop/update-policy` with only platform, architecture, channel and
current product version. The Cloud account client, Profile selection, Agent
Kernel and RunController remain separate authorities. Update requests carry
no account credentials or local Agent data.

The constrained JCS implementation lives in Desktop's deployable shared module;
the original contract scripts re-export that exact implementation. The client
strictly parses the whole transport response, including duplicate keys, before
verifying its `signedPolicy`. A 404 means no policy is available for the request;
it does not prove that the application is the latest release.

## Build trust

`PRIVATE_UNSIGNED` is a literal build property. Authenticode is not required.
Ed25519, exact size/SHA-512, HTTPS, host authorization, revision and safe
shutdown remain required.

Production builds require `CAELUSH_UPDATE_TRUSTED_KEYS_JSON` (raw 32-byte
Ed25519 public keys as unpadded Base64URL) and
`CAELUSH_UPDATE_RELEASE_HOSTS` in addition to the existing Cloud/Offline Grant
trust. Update and Offline Grant keys cannot share key material. Test key IDs,
local release hosts and test TLS roots are forbidden in Production.

Only explicit internal-test builds can embed `d72_test_` public keys and a
localhost HTTPS fixture certificate. The test certificate is public trust
material; its private key and the signing private key stay outside the source
and package. TLS validation is enabled in these clients. These builds do not
represent production Cloud distribution.

## Persistent authority and staging

Application security state resides in
`%LOCALAPPDATA%\Caelush\shared\updates`, independently of Cloud account Profiles.
The updater reuses Windows Profile ACL enforcement. Every path is checked for
reparse points, canonical location, file type, hard links and permissions.
State is bounded, strictly decoded, checksummed and written through exclusive
temporary files, flush and atomic rename. Invalid state fails closed and does
not reset the highest revision. These current-user ACLs are not isolation from
malicious processes running as the same Windows user.

Each channel retains its highest accepted revision and canonical SHA-256 payload
digest. A lower revision or different payload at the same revision is rejected.
Only verified policies advance revision state. Uninstall does not remove this
application-level directory.

The Main downloader authorizes each redirect and final HTTPS host, rejects IP
literals and private DNS answers, uses standard certificate validation,
deadlines and bounded streams, and hashes while writing a unique `.part` file.
Declared-size overflow, truncation or hash mismatch cannot publish an EXE.
Validated streams are flushed and atomically published in the protected staging
directory. Renderer has no path or URL input.

## Safe installation and handoff

Installation requires a native Main confirmation. Browser Guest and user
terminals close through their existing controller, followed by the existing
`closeForApplicationQuit()` authority. A safe-checkpoint or shutdown-pending
response retains the Profile and installer and enters a waiting state. The
updater never kills the Daemon or marks a Run completed. Deferral restores
normal account synchronization through the existing supervisor.
The current Child's bound Credential RPC remains available while shutdown is
blocked so already accepted Agent work can finish. Its existing Child-exit
cleanup releases that RPC after the actual exit; PID, generation, Profile and
credential authority remain unchanged. New proxy requests remain frozen.

After safe Daemon exit, Main captures bounded hashes of the retained database,
replay, backups and encrypted vault. Chromium retains Browser file locks until
the old Electron process exits. The fixed handoff therefore captures all Browser
files after that confirmed exit and before starting NSIS, and binds the bounded
ordinal path/size/SHA-256 fingerprint to the transaction's protected receipt.
The Node verifier uses the same tested fingerprint format. Browser files are
not excluded from post-install data verification. The Browser tree retains
Chromium's AppContainer capability ACLs below the private Profile boundary;
its reparse checks remain required. The staging/config/installer ACLs retain
the strict current-user-only rule. A durable pending transaction
precedes the handoff. A fixed PowerShell process checks current-user NSIS
registration, installer product/version and size/SHA-512 while holding a
Windows `FileShare.Read` handle, which denies writes and deletion until NSIS
exits. It receives only Main-created config, fixed installer switches and
one-use execution authorization; it uses no shell command interpolation or
elevation. App ID and current-user installation identity remain D6's.
The fixed bootstrap uses Windows `Start-Process -WindowStyle Hidden`, avoiding
the Windows PowerShell `DETACHED_PROCESS` startup failure. The independent
helper survives Electron's exit and publishes a private, atomic acknowledgement
bound to its actual PID and the current transaction before Main authorizes
execution. Each confirmed retry has a fresh transaction identity. Policy
expiration is checked again immediately before starting NSIS.

The helper waits for the old Desktop to exit, records the actual installer PID,
exit/cancellation/failure, then restarts the installed executable with its
existing user-data directory. An interrupted handoff is never automatically
re-executed on restart. There is no claim of atomic binary rollback.

## Post-install verification and IPC

Installer exit zero is evidence, not update completion. The new Desktop verifies
the policy again, its target version, complete resource inventory, Node/PTY and
Runner identity, preserved Profile/vault hashes, DPAPI decryption, account
restoration and the existing Daemon compatibility/startup gates. Only then is
the durable transaction completed. Profile verification has its own persisted
boundary so a later startup interruption can resume checks without treating
normal Cloud-token rotation as lost data.

Typed `update` methods expose state/check/download/install/cancel/defer and a
removable state listener on trusted Login and Agent main frames. Other frames,
Browser Guest and arguments containing URLs, paths or commands are rejected.
The account page and existing Agent settings present version, notes, size,
progress, cancellation, confirmation, waiting and errors. Renderer state is a
projection of Main's lifecycle.

## Validation and distribution limits

Focused Desktop and contract tests use small HTTPS fixtures. The Windows D7-2
build/smoke scripts reuse verified D6 runtime resources and generate isolated
0.1.0/0.1.1 installers outside the repository. The formal product version stays
0.1.0. Real upgrade acceptance must observe Main's verified download, real
Agent shutdown, NSIS exit, relaunched version and retained credential/history/
Native Replay/Browser/backup data; mocks cannot supply that gate.

Run the isolated internal build and installed upgrade harness with Node 24:

```powershell
node apps/desktop/scripts/windows-d72-build.mjs
node apps/desktop/scripts/windows-d72-smoke.mjs "D:\<reported build root>\smoke-input.json"
```

The build root is new, outside the repository, and configurable through
`CAELUSH_D72_BUILD_ROOT`; verified D6 resources are selected through
`CAELUSH_D72_D6_RESOURCES`. The smoke refuses an existing Caelush installation,
shortcut, registration or process. It uses isolated D-drive installation and
Profile directories. Its real side-effect fixture blocks a Tool, asserts no
installer starts on `SAFE_CHECKPOINT_PENDING`, releases the Tool and observes
the authoritative `COMPLETED` Run before retrying installation.

Production Cloud/domain/hosting, release-key custody, first-install trusted
delivery, Stable 1.0.0 and clean-host acceptance remain D8. Windows Sandbox
Runner enforcement retains its existing PARTIAL status. Application signatures
protect an already trusted client keyring; they do not establish trust in a
replaced first installer or assert a Windows Publisher identity.
