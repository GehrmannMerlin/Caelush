# CLI Distribution

V1 distribution is a platform-native Node.js 24 portable bundle. It is deliberately not a single-file native executable.

## Build and artifact shape

```bash
pnpm build:release
pnpm test:release
```

The release build compiles the workspace, runs the documented pnpm legacy deploy as a compatibility probe, and uses an isolated production deploy with injected workspace packages for the final staging graph. pnpm 11 legacy deploy leaves workspace links in this repository, so the final layer materializes the reachable production dependency graph into a link-free `node_modules` tree. The artifact is then tested outside the source checkout and without `NODE_PATH`, pnpm, or the pnpm store at runtime.

Artifacts are named `caelush-v<version>-<platform>-<arch>.tgz`, for example `caelush-v0.1.0-windows-x64.tgz`. The artifact contains `bin/caelush`, launcher `dist`, production dependencies, `manifest.json`, `manifest.sha256`, and `checksums.sha256`. The manifest records product/version/platform/architecture, Node range, protocol version, and build time. SHA-256 checksums provide integrity evidence; they are not publisher signatures.

## Node and native constraints

The supported V1 matrix is Windows x64, Linux x64, macOS arm64, and macOS x64. The launcher rejects Node versions outside `>=24.0.0 <25.0.0`. `node-pty` includes platform-native code and must be installed, built, and smoke-tested on the target platform; artifacts are not cross-platform universal bundles. Drizzle migration files are runtime assets and are copied into every runnable artifact. A startup with missing migration assets is a packaging failure.

Because `node-pty` and Drizzle migrations need native/runtime assets, V1 explicitly does not use Node SEA, pkg, nexe, Bun compile, or another single-binary embedding strategy. Avoiding that layer prevents a new native-loader and asset-extraction boundary before the product needs one.

## Install layout

The POSIX installer accepts a local directory or downloaded matching artifact, verifies the manifest/platform and checksums, and installs versioned files under `~/.local/share/caelush/<version>` with a `~/.local/bin/caelush` wrapper. The Windows installer uses `%LOCALAPPDATA%\Caelush\versions\<version>` and `%LOCALAPPDATA%\Caelush\bin\caelush.cmd`, adding only the user PATH entry when absent. Both installers are idempotent and do not implement background updates, registry publishing, release channels, or system PATH mutation.

All published platform artifacts must be built and verified on their target runner. The CI release-smoke matrix covers `windows-latest`, `ubuntu-latest`, `macos-14`, and `macos-15-intel`; unsupported or unavailable hosted targets must be reported rather than represented by a foreign native artifact.
