# Product Version and Compatibility Contract

- **Round:** Caelush Desktop & Cloud — D0-B
- **Canonical source:** root `package.json` `version`
- **Current product version:** `0.1.0` (development)
- **Target stable product version:** `1.0.0`, claimable only after D8-B
- **First planned platform:** Windows x64
- **Daemon API / Protocol:** `/api/v1`, Protocol version `1`

## Version authorities

These versions identify different contracts and must not be conflated:

| Version                   | Authority                                                            | Purpose                                                                                                 |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Product version           | Root `package.json`                                                  | User-visible coordinated Caelush product release                                                        |
| Workspace package version | Each `apps/*/package.json` and `packages/*/package.json`             | Package-manager metadata and publish/deploy metadata; currently a checked mirror of the product version |
| Daemon runtime version    | `apps/daemon/package.json`, read by `apps/daemon/src/version.ts`     | `DaemonInfo.daemonVersion` in the installed package; it does not read the source checkout root          |
| Launcher runtime version  | `apps/launcher/package.json`, read by `apps/launcher/src/version.ts` | Launcher release identity; it does not read the source checkout root                                    |
| API version               | Health and DaemonInfo schema, currently `v1`                         | HTTP route family `/api/v1`                                                                             |
| Protocol version          | Health and DaemonInfo schema, currently integer `1`                  | JSON DTO compatibility boundary                                                                         |
| Sandbox control protocol  | Sandbox Runner manifest and protocol                                 | Separate native child protocol; it is not the Daemon Protocol version                                   |

The root package version is the canonical value. All current workspace application
and package manifests are exact mirrors, with no independent-version exceptions.
`node scripts/check-product-version.mjs` checks SemVer 2.0.0 syntax, every
workspace manifest under `apps/` and `packages/`, required key packages, the
existing Release Builder's Launcher-metadata source, and existing top-level
Caelush Release Manifest versions. The checker reports drift and never edits
files. The present repository has 18 workspace manifests at `0.1.0`.

The legacy Release Builder deploys Launcher metadata into the portable archive
and reads that deployed `package.json` version when creating `manifest.json`.
The version checker guards that relationship; the Release Builder's packaging
behavior remains unchanged. `DAEMON_VERSION` and `PRODUCT_VERSION` keep reading
their adjacent installed package manifests, so installed artifacts do not need
the Monorepo root.

## SemVer and release channels

Versions follow SemVer 2.0.0. Prerelease identifiers order releases; build
metadata does not affect SemVer precedence. The controlled Desktop release
tuple compares the full product version string, including prerelease and build
metadata, because all coordinated release assets must be built from the same
release identity. A difference in build metadata is therefore not an accepted
Desktop/Daemon pairing under this first compatibility matrix.

| Channel  | Intended use                    | Version rule                                                                              |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `dev`    | Internal and development builds | SemVer prereleases and build metadata are permitted                                       |
| `beta`   | Opt-in pre-release testing      | `beta` and `rc` prerelease identifiers are permitted; a stable version may also be tested |
| `stable` | General availability            | The selected update version must not be a prerelease                                      |

The current `0.1.0` is a development repository version. D0-B does not release
Desktop `1.0.0`, change package versions, or make a stable-release claim.
`1.0.0` becomes the stable product version only after D8-B production security
acceptance and stable release gates pass.

## First compatibility matrix

The first Desktop release supports one controlled release tuple:

| Component             | Accepted relationship                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop               | Manifest product version `V`                                                                                                                                |
| Local Daemon          | `DaemonInfo.daemonVersion` must exactly equal `V`; API must be `v1`, Protocol must be `1`, and required capabilities must be declared                       |
| Web assets            | Must be packaged and identified as assets of the same release `V`; the future Desktop Resource Manifest must bind their identity and digest to that release |
| Desktop host identity | Must be verified by the trusted Main/Daemon startup path in addition to version and capability checks                                                       |
| API and Protocol      | Exact `v1` / `1` match; mismatch or invalid strict `DaemonInfo` is rejected                                                                                 |
| Required capability   | Missing or unimplemented capability rejects workspace entry                                                                                                 |
| Optional capability   | Missing capability allows only the documented limited feature set; the client must report it as unavailable                                                 |

`evaluateDesktopDaemonCompatibility` is a pure client-side policy evaluator. It
validates strict `DaemonInfo`, rejects API/Protocol/product-version mismatches,
requires a caller-supplied verified host identity, checks required and optional
capabilities, and never treats a remote declaration as implementation. Its
current implemented Desktop security capability set is empty. D0-B does not
create a Host Token verifier or perform process authentication; only trusted
Main code in a later implementation may assert `hostIdentityVerified: true`.

No cross-Patch or cross-Minor Desktop/Daemon compatibility is promised. Any
future widening needs a documented matrix and protocol tests before client
logic changes. The existing ordinary Launcher path stays as it is: local reuse
requires exact Launcher/Daemon product-version equality, while an externally
configured Daemon retains its existing API/Protocol checks and mismatch warning.
Web and CLI do not acquire a Cloud-login requirement. New optional strict-schema
capabilities are not added to production DaemonInfo until the corresponding
capability is implemented; this preserves old strict clients.

## Release identity work still deferred

The existing portable Release Manifest identifies product, version, platform,
architecture, Node range, Daemon Protocol version, sandbox Runner identity,
and feature gates. It does not yet identify the Desktop executable, Desktop
channel, Web asset digest, standalone Node runtime, native module ABI, or full
Desktop resource set. D6 owns the installed Desktop Resource Manifest and
installer binding. The existing portable Node archive and its manifest remain
separate release products.

Cloud may deploy independently of the Desktop bundle. Cloud API versioning,
Daemon API/Protocol versioning, workspace package metadata, and product version
remain separate axes. Cloud deployment version never changes Agent execution
and is not injected into the local Agent Context or Prompt Surface.
