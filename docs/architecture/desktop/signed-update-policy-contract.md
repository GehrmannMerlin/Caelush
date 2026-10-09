# Signed Desktop Update Policy Contract

- **Round:** Caelush Desktop & Cloud — D0-B
- **Scope:** normative offline contract and test verifier; no production update client
- **Target artifact:** Windows x64 Desktop
- **Production implementation:** D7-A–D7-C

## Envelope and trust model

The Cloud update endpoint returns a JSON-safe `SignedUpdatePolicyEnvelope`:

```json
{
  "envelopeVersion": 1,
  "payload": { "schemaVersion": 1, "keyId": "release-key-1" },
  "signature": "unpadded-base64url-ed25519-signature"
}
```

The example is illustrative; the complete exact field sets are the `DesktopUpdatePolicy`,
`DesktopRelease`, and `SignedUpdatePolicyEnvelope` schemas in
[`cloud-api-v1.openapi.json`](./cloud-api-v1.openapi.json). The policy payload
is signed; the envelope version and Cloud `requestId` are outside the signature.
`keyId` is inside the signed payload, so changing the selected key invalidates
the signature. The signature is Ed25519 over the canonical UTF-8 payload bytes.
It decodes to exactly 64 bytes and is encoded as 86 unpadded Base64URL characters.

The client owns a pinned keyring mapping `keyId` to Ed25519 public keys. An
unknown key ID, invalid key, malformed signature, or failed signature is a
hard rejection. Key additions, overlap windows, revocation, and rotation
operations belong to D7; no production signing key is present in this
repository. Test vectors use only a test-only public key and signature; the
private key is not stored.

## Canonical payload bytes

The payload uses the D0-B constrained RFC 8785 JSON Canonicalization Scheme
(JCS) profile. Canonical JSON has no insignificant whitespace; object keys are
ordered by UTF-16 code units; strings use JSON escaping and preserve Unicode
scalar values; the resulting text is UTF-8 encoded. The contract restricts
numeric values to safe base-10 integers because current signed fields only need
integer revisions and sizes. It rejects fractional/exponent notation, negative
zero, values outside JavaScript's safe integer range, invalid surrogate
sequences, duplicate decoded object keys, sparse arrays, unsupported values,
excessive depth, and trailing JSON. This is the same fixed domain Python and
TypeScript must implement and test; it is not permission for either runtime to
sign a different serialization.

Only `payload` is canonicalized and signed. `requestId`, outer `envelopeVersion`,
and `signature` do not affect the signed bytes. The payload includes its own
`schemaVersion` and `keyId`. D1/D7 Cloud work must reuse the fixed cross-language
vectors rather than introduce a second canonicalizer.

The committed vector in
[`canonical-policy-v1.json`](../../../tests/contracts/fixtures/canonical-policy-v1.json)
and [`canonical-policy-v1.expected.json`](../../../tests/contracts/fixtures/canonical-policy-v1.expected.json)
asserts canonical UTF-8 hex, SHA-256 digest, and Ed25519 verification. It is an
offline contract vector and is not a production update result.

## Frozen payload fields and checks

The exact signed payload fields are:

| Field                     | Contract                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | Integer `1`                                                                                                     |
| `product`                 | `caelush`                                                                                                       |
| `platform`, `arch`        | `windows`, `x64` for this first Desktop target                                                                  |
| `channel`                 | `dev`, `beta`, or `stable`                                                                                      |
| `currentVersion`          | Client product version echoed from the policy request                                                           |
| `latestVersion`           | SemVer 2.0.0 selected by this policy                                                                            |
| `minimumSupportedVersion` | SemVer 2.0.0 lower bound for supported clients                                                                  |
| `mandatory`               | Whether the update gate is mandatory                                                                            |
| `graceDeadline`           | Nullable RFC 3339 UTC deadline; if present, inside the signed validity window; an optional update cannot set it |
| `revision`                | Positive safe integer, strictly monotonic for product/platform/architecture/channel                             |
| `release`                 | One exact `DesktopRelease` with version, HTTPS URL, positive size, lowercase SHA-512 hex, and bounded notes     |
| `issuedAt`, `expiresAt`   | RFC 3339 UTC instants; expiry follows issue time                                                                |
| `keyId`                   | Stable identifier selecting the trusted Ed25519 public key                                                      |

Validation rules:

- `currentVersion`, `latestVersion`, `minimumSupportedVersion`, and
  `release.version` are valid SemVer 2.0.0 values; `release.version` equals
  `latestVersion`.
- A policy cannot select a version lower than the client's current version.
  `minimumSupportedVersion` cannot exceed `latestVersion`.
- `stable` cannot select a prerelease. A `beta` prerelease uses a `beta` or
  `rc` identifier. Build metadata does not affect SemVer precedence.
- The update revision cannot decrease below the locally accepted revision.
  Reusing a revision with different canonical payload bytes is a conflict and
  is rejected.
- Policy validity is checked using the local verifier clock. Expired or not-yet
  valid policies are rejected. An offline grant and update-policy validity are
  distinct contracts.
- Artifact URLs must use HTTPS, contain no user information or fragment, and
  have a hostname exactly present in the release-host allowlist. Redirect and
  final-host policy must be enforced by the production downloader as well.
- `release.sha512` is the 128-character lowercase hexadecimal SHA-512 digest
  of the downloaded artifact. The exact byte count must match
  `artifactSize` before handoff.

The current verifier in `scripts/contracts/signed-update-policy.mjs` performs
strict offline shape, signature, URL, validity-window, SemVer, size/digest
format, and revision checks. It does not download, persist accepted policy
state, fetch keys, install files, run Authenticode, or coordinate Daemon
shutdown.

## Release Manifest binding and verification layers

The legacy `scripts/build-release.mjs` Release Manifest currently includes
`product`, `version`, `platform`, `arch`, `nodeRange`, `createdAt`,
`protocolVersion`, sandbox Runner status/identity, and feature gates. Its
checksum files are for the portable archive; they are not the future Desktop
installer's signed `artifactSize` and SHA-512 record. The current manifest does
not claim a release channel, Desktop Resource Manifest, or installer
Authenticode identity.

The D7 update pipeline must bind the signed policy and Updater Manifest to the
same product, version, platform, architecture, channel, artifact URL, byte
size, and SHA-512 digest. The downloaded file must pass all three gates before
execution:

1. Verify the Cloud policy's Ed25519 signature and monotonic revision.
2. Verify exact artifact size and SHA-512 bytes against the matching release
   manifest.
3. Verify the Windows Authenticode signature and expected publisher identity.

Any mismatch rejects the file. No unchecked download is passed to an installer.
The client defaults to refusing downgrade. A mandatory policy may require the
next safe update opportunity, but it cannot interrupt a durable Core boundary,
abandon an in-flight Tool side effect, change Run completion, or bypass Core's
safe shutdown semantics.

## Test ownership and deferred work

The offline tests cover canonical bytes, fixed signature verification,
duplicate keys, malformed Unicode, unsupported numeric forms, tampering,
unknown `keyId`, invalid validity windows, revision rollback/conflict, SemVer
channel checks, downgrade refusal, and release artifact shape. They do not
prove a Cloud deployment, key rotation, download behavior, Authenticode trust,
installer security, or real update availability.

- D1-A–D1-C: Cloud API implementation and cross-language contract tests.
- D7-A–D7-C: release records, production signing/key rotation, updater
  manifest, download/redirect policy, artifact verification, and installation
  coordination.
- D8-A–D8-B: production key custody, operational audit, deployment, and stable
  release acceptance.
