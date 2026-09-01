# Phase 13A Production Web Foundation Design

## Goal

Turn `@caelush/web` into a small production browser application hosted by the
loopback daemon. The browser performs only a Web Host bootstrap and keeps a
local projection of connection state; the daemon, Protocol, and existing
client remain authoritative.

## Architecture

The daemon serves the compiled Web assets from one fixed, canonical build
root. `GET /` injects a bounded JSON launch context containing the existing
Protocol `WorkspaceRef`; `/assets/*` serves only files contained by that build
root; `/api/v1/*` continues through the existing routes and not-found handler.
The same-origin browser creates exactly one `CaelushClient` and calls
`getHealth()` followed by `getInfo()`. A small host model maps those results to
bootstrap states and never models Run state.

The existing launcher gains only the `web` host entrypoint needed to pass the
current workspace path and Web build root when it starts or reuses the daemon.
The daemon derives a canonical workspace path and a deterministic valid
`WorkspaceId` from that path for the launch context. No Protocol schema or
business REST endpoint is added.

## Boundaries

- Web-facing shared entities continue to come from `@caelush/protocol`.
- Web production source has no session, run, event, tool, approval, recovery,
  or fabricated product data.
- Static serving never resolves paths from the workspace and rejects traversal,
  symlink escape, and API fallback.
- Static HTML receives CSP, `X-Content-Type-Options`, and `Referrer-Policy`.
- Bootstrap errors are reduced to fixed safe messages; raw errors, stacks,
  environment values, credentials, and provider details never reach the DOM.
- Release packaging copies the Web build as an asset; the daemon does not
  import the Web application or create a second runtime.

## Verification

Focused tests cover the host model, safe errors, stable workspace identity,
static asset containment, SPA/API routing, security headers, and loopback
request rejection. The Web package build produces `dist/index.html` and
hashed assets. A real daemon smoke exercises `/`, `/assets/*`, health, info,
and launch-context injection before the repository regression commands.
