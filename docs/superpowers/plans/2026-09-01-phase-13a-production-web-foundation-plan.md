# Phase 13A Production Web Foundation Implementation Plan

> **For agentic workers:** Execute this plan inline in the current isolated worktree. Keep every production behavior test-first and stop at the Phase 13A boundary.

**Goal:** Establish a same-origin, loopback-only production Web Host backed by the existing daemon and `@caelush/client`.

**Architecture:** The daemon serves a fixed Web build root and injects a validated `WorkspaceRef` launch context into `index.html`. A React browser shell owns only host bootstrap state and uses one `CaelushClient` for health and info.

**Tech Stack:** TypeScript, React, Vite, Fastify, `@caelush/client`, `@caelush/protocol`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-phase-13a-production-web-foundation-design.md`

## Global Constraints

- Do not modify Core, Tools, Security, Runtime, Verification, Context, LLM, Events, or Storage.
- Do not add Protocol entities, AgentEvents, business REST APIs, CORS, a Web backend, or a second Agent runtime.
- Do not implement Session, Run, Timeline, Approval, Cancellation, Reconnect, Recovery, Inspector, or mock product data.
- Keep `/api/v1/*` on the existing daemon route and error path; static fallback must never consume it.
- Use `@caelush/client` for every daemon request and validate the launch context against Protocol schemas.
- Use focused tests first, then Web build, real-daemon smoke, and the requested full regression commands.

### Task 1: Record the host model and package boundaries

**Files:**

- Create: `apps/web/index.html`, `apps/web/src/*`, `apps/web/vite.config.ts`, `apps/web/package.json` changes.
- Create: host model and bootstrap tests under `apps/web/test/`.

- [ ] Write failing tests for launch-context validation, safe error projection, bootstrap success/failure states, and stable client factory identity.
- [ ] Run only those tests and confirm they fail because the host model does not exist.
- [ ] Implement the smallest browser-safe model and React entry that uses a supplied `CaelushClient`.
- [ ] Run the focused Web tests and typecheck.

### Task 2: Add the daemon static Web host

**Files:**

- Create: `apps/daemon/src/web/static-host.ts` and workspace launch-context helper.
- Modify: `apps/daemon/src/app.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/main.ts`, public daemon exports.
- Create: `apps/daemon/test/web-static-host.test.ts` and workspace identity tests.

- [ ] Write failing tests for `/`, hashed assets, SPA fallback, API preservation, traversal/symlink rejection, cache policy, headers, and invalid launch context.
- [ ] Run those tests and confirm the expected missing-host failures.
- [ ] Implement fixed-root canonicalized serving and safe HTML bootstrap injection without changing API route contracts.
- [ ] Run daemon static-host tests plus existing loopback guard tests.

### Task 3: Integrate the existing launcher without duplicating the daemon

**Files:**

- Modify: `apps/launcher/src/main.ts`, `apps/launcher/src/daemon-discovery.ts` only if required for Web host startup.
- Create: launcher Web host tests.
- Modify: `scripts/build-release.mjs` only to carry compiled Web assets into the existing artifact.

- [ ] Write failing tests for the `web` command's workspace/build-root environment handoff and its safe failure when assets are absent.
- [ ] Run the launcher tests to verify the new behavior is absent.
- [ ] Implement the minimal command and release asset copy; do not start the daemon in-process.
- [ ] Run launcher tests and release packaging characterization tests.

### Task 4: Run production checks and deliver

- [ ] Build `@caelush/web` and verify `dist/index.html` plus assets.
- [ ] Run a real daemon smoke against the built Web root, then fetch `/`, an asset, `/api/v1/health`, and `/api/v1/info`.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [ ] Inspect `git diff --check`, status, generated files, and secret boundaries.
- [ ] Commit with `feat(web): establish production web host foundation`.
- [ ] Push the exact 13A branch and compare local and remote SHA.
