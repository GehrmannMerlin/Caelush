# Desktop development

Caelush Desktop loads the shared Agent workbench built from `apps/web`.
Desktop owns the Electron shell, account screens, application updates, and
native workspace integrations. The daemon remains the only Agent composition
root.

## Routine commands

Run from the repository root with the pinned Node and pnpm versions:

On a fresh checkout or after dependency/lockfile changes, first run
`pnpm install --frozen-lockfile`. The workspace disables pnpm's automatic
pre-run dependency reinstall; build and launch commands reuse installed
dependencies.

| Command                                                     | Behavior                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:desktop`                                          | Build the daemon, shared workbench, Electron main/preload, and account renderer, then launch Desktop with Vite. |
| `pnpm build:desktop`                                        | Build all Desktop development artifacts, including the account renderer. Does not create an installer.          |
| `pnpm start:desktop`                                        | Launch the existing build without rebuilding. Missing artifacts produce a rebuild instruction.                  |
| `pnpm --filter @caelush/web build:desktop`                  | Rebuild only the shared Agent workbench for Desktop. Reload the workbench afterwards.                           |
| `pnpm --filter @caelush/desktop build:main`                 | Rebuild Electron main/preload. Restart Desktop afterwards.                                                      |
| `pnpm --filter @caelush/desktop package:win`                | Explicitly create a Windows installer using the release build configuration.                                    |
| `pnpm --filter @caelush/desktop test:reliability:workbench` | Launch the isolated Electron workbench smoke on Windows x64 with local Cloud and Provider fixtures.             |

The reliability workbench smoke launches a real Electron window with a
disposable user-data directory and local Cloud/Provider fixtures. It exercises
the shared workbench through the Desktop host, including workspace isolation,
a model-backed fixture Run, and the integrated terminal. It does not use the
signed-in user profile, a real Provider, or a paid model request. The existing
`test:windows:d5` command remains available as the platform-specific name for
the same smoke.

The Desktop dev process starts Vite on loopback port 5174 and rebuilds the
account renderer before launch. Account views opened from the shared workbench
use `caelush-login://app/?view=account`, which serves the static
`apps/desktop/dist/renderer` assets through the custom protocol. The dev build
keeps those assets current before each launch. The Agent workbench uses the
built `apps/desktop/.stage/web` assets; it is not served by the account
renderer Vite instance. Shared workbench edits therefore need a
`build:desktop` followed by a page reload. Main/preload or daemon edits need
their relevant build and a process restart. Restarting an existing build does
not compile source files or generate installers.

## Cloud configuration and development data

Save the hosted Cloud origin in the ignored
`apps/desktop/.env.development.local`:

```dotenv
CAELUSH_CLOUD_ORIGIN=https://your-cloud-host.example
```

Explicit process environment values override this file. Production and
internal-test builds do not read it. Desktop-only development does not require
restarting the deployed Cloud Docker service; changes to Cloud itself have
their own deployment workflow.

Both development launchers default to the same isolated data root:

```text
apps/desktop/.stage/
  daemon/                    verified local Node/terminal resources
  web/                       Desktop workbench assets, independent of Web dist
  electron-runtime/
    current/electron/        reusable, verified Windows Electron runtime
  development/
    electron-user-data/      development browser state and credentials
    Caelush/                 development account profiles and Agent data
```

The development profile is separate from installed application data. On first
launch with this isolated profile, sign in again; existing data is retained at
its original location. An absolute `--isolated-data-dir` argument or
`CAELUSH_DESKTOP_DEV_DATA_ROOT` selects another development profile. Use the
same selection for `dev` and `start` to see the same account and sessions.

On Windows, the launchers reuse Electron from the installed pinned dependency.
The cache is verified against the source runtime and copied only when missing,
damaged, or changed. Concurrent preparation is rejected; close other Desktop
processes before upgrading or repairing this cache. The temporary preparation
directory is fixed and replaced on retry. Smoke scripts that explicitly request
a disposable runtime retain their existing per-run cleanup behavior.

## Cleanup

Close Desktop before cleaning its runtime or build files. Preview with:

```powershell
pnpm clean:desktop:release --dry-run
pnpm clean:desktop:dev --dry-run
```

Remove the selected generated output with:

```powershell
pnpm clean:desktop:release
pnpm clean:desktop:dev
```

Release cleanup removes `release-artifacts/desktop` and the copied packaging
resources under `apps/desktop/.build-resources`. Development cleanup
removes only `apps/desktop/dist`, `.stage/daemon`, `.stage/web`, and `.stage/electron-runtime`.
It preserves source, dependencies, `.env.development.local`, isolated account
data, and other release outputs. Targets are checked for containment and linked
ancestors before deletion. After development cleanup, run `pnpm build:desktop`.

## Shared UI maintenance

Changes to shared Agent behavior and components apply to Web and Desktop.
Desktop-only actions are passed from the host integration into shared UI;
presentation components do not detect custom URL protocols or access Electron.
The version-one preload bridge is resolved in
`apps/web/src/host/desktop-integration.ts`. Missing or unsupported bridges expose
no native capabilities; individual incomplete capabilities are disabled.

Account navigation, update actions, and native panels remain optional host
integrations. Skill/MCP domain logic belongs to the shared Agent/daemon path;
native file selection and OS actions adapt that path for Desktop.

When modifying a large component, inspect its responsibilities, repeated markup,
CSS scope, and host accesses first. Extract cohesive reusable components under
focused behavior tests. File length alone is not a reason to create an
abstraction. Shared changes require tests and builds for both hosts; Desktop
integration changes require the corresponding preload and native checks.
