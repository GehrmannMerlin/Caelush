# Phase 12E Release-Surface Characterization

This snapshot records the release surface observed at the start of Phase 12E. It is evidence for the design and is not a second source of architectural contracts.

## Current entrypoints and package graph

- The root package is private, ESM, version `0.1.0`, and requires Node `>=24.0.0 <25.0.0` with pnpm `11.21.0`.
- `@caelush/cli` and `@caelush/daemon` are private packages. Their development commands are `node dist/index.js` and `node dist/main.js` respectively.
- The CLI depends on the client and protocol plus Ink/React presentation packages. It is a thin HTTP/SSE host and has no direct Core, Storage, Runtime, Security, Tools, Verification, or LLM dependency.
- The daemon is the local service composition root and depends on Context, Core, Events, LLM, Protocol, Runtime, Security, Storage, Tools, Verification, Fastify, and SSE support.
- The workspace contains `apps/*` and `packages/*`; no `inject-workspace-packages` setting is enabled.

## Runtime and asset constraints

- `@caelush/runtime` depends on `node-pty`, a platform-native native addon. A deployment must be built on and tested on the target OS/architecture.
- Storage migration code resolves Drizzle migrations through `import.meta.url`; the migration directory under `packages/storage/drizzle` is a runtime asset and is not optional in production.
- ESM and compiled `import.meta.url` asset resolution must continue to work after pnpm deploy.
- Built-in tools and verification use the Git executable and ripgrep executable where available. Doctor and artifact smoke tests must distinguish missing executables from application failures.
- Ink/React are interactive-only concerns. A non-TTY product invocation must not render Ink or request raw terminal input.

## Host defaults and lifecycle

- The default daemon URL is `http://127.0.0.1:43120`.
- The daemon currently chooses `~/.caelush/caelush.db` when no explicit database path is provided.
- The CLI currently does not auto-start a daemon and its main lifecycle renders the interactive application after parsing its existing `--continue`/`--resume` grammar.
- The current daemon composition reports API `v1`, protocol `1`, and daemon version `0.1.0`; the latter is presently a literal and must become authoritative metadata.

## Required Phase 12E release implications

The release layer must therefore provide a product launcher, separate daemon process startup, user-owned product directories, a portable Node 24 bundle, explicit migration inclusion, target-platform node-pty installation, a pre-render TTY gate, a separate print host, and artifact tests outside the repository. It must not move Agent execution into the launcher or introduce a single-file native packaging runtime.
