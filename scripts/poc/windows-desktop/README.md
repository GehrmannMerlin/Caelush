# Windows x64 Desktop Feasibility POC

This is an isolated D0-C validation harness. It is not an Electron product app
and does not add a package under `apps/desktop`.

## Run

From a Windows x64 development checkout with a portable Caelush release archive
freshly built from the checkout available:

```powershell
$bundlePath = "C:\path\to\fresh\caelush-v0.1.0-windows-x64.tgz"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc/windows-desktop/run.ps1 -BundlePath $bundlePath
```

`-BundlePath` is required so a stale ignored release archive cannot silently
make the POC test an older checkout. The POC uses the existing product bundle
as input; it does not invoke or change the Release Builder. Producing that
current-source archive remains a separate build prerequisite.

The script pins Node `24.18.0` and Electron `44.7.0`. It downloads the official
Windows x64 Node archive over TLS and checks SHA-256 against the pinned official
Node checksum. `npm ci` installs the isolated Electron dependency using the
committed `package-lock.json`. The script downloads Electron's exact Windows x64
archive from `cdn.npmmirror.com` over TLS and checks it against the SHA-256
entry in that pinned npm package's `checksums.json` before extraction. Large downloads and extracted test files remain under
the current user's temporary directory and are not committed. `-KeepStage`
retains the generated portable directory for inspection.

At runtime, Electron and its Daemon child receive a restricted `PATH` containing
only Windows `System32`. The POC invokes the Node executable by its absolute
path under the copied stage and invokes the packaged Daemon through the
production `@caelush/daemon` entry. No global Node, pnpm, Cargo, Rust compiler,
workspace checkout, or `node_modules` link is used by the staged process.

The child is created by Electron Main with Node's private process IPC channel.
The one-use random bootstrap value is sent only in the first IPC message. The
child reports its PID, generation, and OS-assigned loopback port over that
channel. Main validates the PID and generation, then validates Health/Info with
the existing `@caelush/client`. The HTTP path is deliberately labeled
`POC_ONLY_UNAUTHENTICATED_TRANSPORT`; it does not implement Host Token, Profile
binding, or `desktopLocalProxyV1`.

The scripted provider is local to `poc-child.mjs`; its endpoint is not called.
The representative Run, replay, PTY echo, SQLite database, and Runner functional
probe use disposable paths under the generated stage and are removed on exit.

The Runner probe checks the packaged manifest and SHA-256, performs the real
workspace status/prepare control operations, then launches a restricted Windows
child against a disposable workspace. It verifies a workspace write succeeds
and a sibling-directory write is denied. ACL preparation is limited to the
generated temporary fixture and its directory is removed with the stage.

The Electron embedded-Node probe is bounded: it records Electron's embedded
Node/ABI versions, checks ESM and `node:sqlite`, loads the packaged `node-pty`
native module in that runtime, and exercises PTY I/O using the separately
bundled Node child. It does not run the entire Daemon under Electron's embedded
runtime.

The script writes a machine-readable evidence JSON outside the repository and
prints its path. That JSON records measured runtime versions, process/IPC
results, durable SSE sequences, SQLite integrity, and native binary hashes.

This local portable-directory run cannot satisfy the clean Windows VM/Sandbox
gate. Do not treat it as a clean-host test.
