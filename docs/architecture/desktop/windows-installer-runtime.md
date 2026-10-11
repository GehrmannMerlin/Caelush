# Windows Installer and Packaged Desktop Runtime

D6 packages Caelush `0.1.0`, channel `dev`, for Windows x64. Electron
`44.7.0` and Electron Builder `26.17.0` are pinned. `apps/daemon` remains the
only Agent composition root. The desktop installer does not introduce another
Agent runtime or change the API `v1` / Protocol `1` contracts.

## Build entry points

```powershell
$env:CAELUSH_DESKTOP_OUTPUT_ROOT = 'D:\Caelush Desktop Build'
pnpm --filter @caelush/desktop package:win
pnpm --filter @caelush/desktop package:win:dir
pnpm --filter @caelush/desktop test:windows:d6
```

Choose a new output directory for each build. The D6 entry point requires the
output and staging resources on D:, outside the source checkout. It rejects a
Low Mandatory Integrity label on the output directory. NSIS temporary files
also use the D: output tree. Node and Electron are reused from verified local
caches; packaging does not redownload them for every build.

The default build orders dependency builds, desktop Web, desktop typechecking,
Main/Preload, login Renderer, external resource staging, manifest generation,
Runner/PTY probes, Electron Builder, the packaged Electron path probe, and the
NSIS installed lifecycle smoke. The CLI portable archive remains a separate
build and manifest contract.

For a Main-only repair, `CAELUSH_DESKTOP_REUSE_RESOURCES_FROM` can explicitly
identify an earlier external `resources` stage. This branch typechecks and
rebuilds Main/Preload, checks every staged file and its version, checks that the
login Renderer digest is unchanged, and packages a new `app.asar` and NSIS.
It must not be used after changing Daemon, workspace runtime packages, Web,
Node, PTY, or Runner inputs. It rejects a packaged stage containing `app.asar`;
the archive must be regenerated from the current Main build.

## Installed layout

```text
Caelush.exe
resources/
  app.asar
  desktop-resource-manifest.json
  daemon/
    node.exe
    user-terminal-helper.mjs
    node_modules/node-pty/
    runtime/
      package.json
      dist/desktop-entry.js
      node_modules/
  web/desktop/
    index.html
    assets/
  sandbox-runner/
    caelush-sandbox-runner.exe
    manifest.json
```

Main, Preload, and the login Renderer reside in ASAR. Independent Node,
production Daemon dependencies, Web assets, ConPTY addons, the terminal
Helper, and Runner use `extraResources` and real filesystem paths. The
production Daemon dependency closure uses a hoisted deployment with package
metadata and public workspace package entry points. The installer does not
copy the monorepo or use the development `.stage` tree at runtime.

Installed paths resolve from `process.resourcesPath`. Daemon Runner discovery
accepts exactly the Desktop `daemon/runtime/dist/desktop-entry.js` layout and
the existing Portable `node_modules/@caelush/daemon/dist/main.js` layout. It
does not search arbitrary ancestor directories.

## Resource integrity contract

`desktop-resource-manifest.json` schema `1` contains product/channel/platform
identity, Electron/Daemon/API/Protocol versions, Node version and executable
SHA-256, Web and desktop asset digests, the PTY module version and native
ABI/N-API identity, Runner protocol and hash, required Daemon capabilities,
the complete resource file list, and its aggregate SHA-256 digest.

Each file record has a normalized relative path, file type, size, SHA-256, and
runtime identity. Absolute paths, traversal, ambiguous Windows path names,
duplicate paths, symbolic links/reparse points, hard links, missing files,
unexpected files, changed content, incompatible versions, and incorrect
native identities fail validation. Set digests bind sorted path, size, and
content-hash records. The manifest itself is the declared manifest exception
to the resource file list.

Electron Builder's `afterPack` binds the final `app.asar` bytes to the
manifest. Under Electron the verifier uses `original-fs` for archive metadata
and hashing; Electron's virtual ASAR filesystem cannot identify the archive
as an ordinary file. Main verifies the resources before opening a window,
executes the bundled Node identity probe, loads the PTY addon with that Node,
and verifies Runner metadata. Failed checks stop startup.

Current-user installation does not require the Elevate Helper, so
`packElevateHelper: false` avoids a post-`afterPack` undeclared resource. Strict
file-set verification remains enabled for the final installed directory.
Future update configuration must reassess the helper requirement.

These digests establish internal consistency. The D6 manifest and installer
are unsigned and provide no publisher authenticity against an attacker who
can replace both resources and metadata. Signed release metadata,
Authenticode, installer signature verification, and update trust belong to D7.

## Build purpose and trust configuration

Build purpose is independent of release channel. `NODE_ENV=production` or a
Stable channel requires the production checks unless an explicit internal
test purpose is selected. A development purpose cannot downgrade these
requirements. Production requires an explicit HTTPS Cloud origin, matching
host allowlist, and nonempty trusted Offline Grant keyring. D6 test key IDs
are rejected in production.

The D6 packaging entry point creates an explicit `internal-test` build with
channel `dev`, a loopback Cloud origin, and a generated test key whose ID starts
with `d6_test_`. Its private key stays in the D: ignored output directory and
is never included in the installer. This installer is an internal development
artifact bound to a controlled local fixture. It is not a Stable distribution
or a substitute for production Cloud configuration.

## Installation identity and data

NSIS uses App ID `com.caelush.desktop`, product name `Caelush`, and current-user
installation without elevation. It creates the Start Menu shortcut; desktop
shortcut creation is disabled by the development configuration. Default
uninstallation preserves application data.

The install registry key owns `InstallLocation`; the uninstall registry key
owns `DisplayName`, `DisplayVersion`, and `UninstallString`. Smoke validates
both HKCU keys against the same generated installation identity and verifies
that the uninstaller remains within its isolated installation root. Start
Menu discovery uses Windows `FOLDERID_Programs` rather than a modified
`APPDATA` environment variable. Silent `/D=` is last and unquoted, with Node's
Windows verbatim argument handling. Uninstallation explicitly uses
`/currentuser` and the same Windows Shell context as installation.

Account Profiles stay under `%LOCALAPPDATA%\Caelush\profiles\u_<digest>`;
desktop DPAPI data stays in Electron's user-data directory. Program resource
replacement does not replace these data directories. Legacy import accepts
only an empty target Profile. It rechecks emptiness after protected backup
staging and permits replacement of a schema-only database initialized by
Main. A target containing user data remains rejected. Provider credential
authority and backup cryptography remain unchanged.

## Acceptance evidence boundaries

The installed smoke starts the actual installed `Caelush.exe` and production
Main. It uses isolated D: installation and user-data roots, a versioned local
Cloud fixture, and a local scripted Provider. It verifies login and a signed
Grant, protected backup import, Provider Vault, Agent completion, SSE replay,
Files, ConPTY, HTTPS Browser Guest isolation, logout, graceful Daemon/Host
shutdown, same-version reinstall, and uninstall/data retention. A restarted
Provider turn uses decrypted Native Replay and a Vault credential without an
environment API Key; directory existence is supplemental evidence only.

D5 Test Main can supply a disposable backup source fixture; its result is not
proof of installed production Main. Reusing an earlier fixture is explicitly
recorded as a backup seed only. Failed shutdown, nonzero child exits, missing
required persistence, and failed production Main checks prevent a PASS.
Login readiness is read through the Account/AgentEntry projection; Workspace
IPC is checked only after navigating to the trusted Agent origin. Final model
text is not durable completion: smoke waits for the formal API to report
`COMPLETED`. The direct terminal driver replies to ConPTY cursor-position
queries as xterm does, with bounded output and operation timeouts. Window
control remains Login-only, so smoke returns to that page for graceful close.
The silent uninstall harness executes with `_?=` so it can observe the actual
uninstaller exit; that mode can retain its own executable. It accepts only
that exact NSIS stub, and records the residual separately from application
payload removal.

The Runner reports the existing Windows restricted-token enforcement as
`PARTIAL`. READY/ERROR transport and actual restricted execution must work;
this is not a hard Windows OS sandbox claim. Renderer sandbox, context
isolation, Web Security, D4 Host Token, and Profile/Vault authorization stay
enabled.

`D0-C G7 / D6 G7 = DEFERRED_BY_USER`. A clean Windows environment is not part
of D6 Development Scope and is not a PASS. It must be reassessed before
Stable `1.0.0`. Incrementing-version upgrade and automatic update acceptance
remain separate from D6's real same-version reinstall check.
