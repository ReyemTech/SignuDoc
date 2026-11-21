# Branded PDF Evidence and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a branded audit page and QR verification link to SignuDoc-managed PDFs, plus a privacy-limited public envelope lookup and PDF hash fallback.

**Architecture:** Generate an unguessable bearer token once for each finalization, keep its hash on the envelope, and carry the raw token only in memory or the already encrypted recovery payload. Add branded audit content before SignuDoc's final seal. Preserve signer-provided PAdES document bytes and put the QR on the separate certificate instead.

**Tech Stack:** Next.js 16 App Router, PostgreSQL migration runner, `pdf-lib`, existing PAdES utilities, existing `uqr`, `sharp` for PDF-compatible logo/QR rasterization.

**Spec:** `docs/superpowers/specs/2026-11-20-branded-evidence-and-field-tools-design.md`

## Global Constraints

- QR content must not contain the final PDF hash; adding the QR page changes that hash.
- Signer-provided PAdES signatures must remain intact.
- Public verification URLs are bearer links and must use high-entropy tokens; only token hashes are stored on envelopes.
- Public responses must not expose signer contact details or unredacted event streams.
- Upload verification confirms an exact recorded SHA-256 match; do not present it as a generic certificate trust check.
- Do not add or run tests unless the user requests testing or verification.

## Review Focus

- A retry must retain the same verification token so an already-rendered QR does not become stale.
- Hashes must be computed after the final branded page and seal are in the file.
- Rendering failures must not publish a completed envelope with an unusable verification URL.
- Unknown tokens, deleted envelopes, and non-completed envelopes must reveal no record details.
- Signer-provided PAdES bytes must not be rewritten to add trail content.

---

### Task 1: Add durable public verification token data

**Files:**
- Create: `db/migrations/20261120100000_public_verification.sql` (use the next available migration timestamp if one exists)
- Modify: `src/lib/schemas/envelope.ts`
- Create: `src/lib/public-verification.ts`
- Modify: `src/lib/recovery/finalization-payload.ts`
- Modify: `src/lib/signing.ts`
- Modify: `src/lib/recovery/finalization.ts`
- Modify: envelope row mappers in `src/lib/envelopes.ts`

**Interfaces:**
- Produces: `createPublicVerificationToken(): { token: string; tokenHash: string }` and `hashPublicVerificationToken(token: string): string`.
- Produces: `publicVerificationToken: string` in the encrypted finalization payload; envelope records persist only `publicVerificationTokenHash`.

- [ ] **Step 1: Add a nullable token-hash column and unique index**
  - Use a new migration; leave existing completed envelopes with a null token hash so their files remain verifiable by upload hash.
- [ ] **Step 2: Add token generation and lookup hashing**
  - Use Node cryptographic randomness with at least 256 bits of entropy and SHA-256 for storage.
- [ ] **Step 3: Carry the raw token safely through finalization**
  - Generate it once when finalization is accepted.
  - Add it to the encrypted recovery payload for retry stability; in the synchronous path keep it in memory until the completed-envelope transaction persists only the hash.
  - Persist the hash in the same transaction that publishes the completed artifacts.
- [ ] **Step 4: Review failure and retry paths**
  - Confirm stale jobs cannot publish a token hash, retries use the payload token, and no raw token is logged or stored outside encrypted payloads/PDF artifacts.
- [ ] **Step 5: Commit**

```bash
git add db/migrations src/lib/schemas/envelope.ts src/lib/public-verification.ts src/lib/recovery/finalization-payload.ts src/lib/signing.ts src/lib/recovery/finalization.ts src/lib/envelopes.ts
git commit -m "feat: add private storage for public verification tokens"
```

### Task 2: Render branded audit pages and QR codes before sealing

**Files:**
- Modify: `src/lib/services/pdf-finalize.ts`
- Modify: `src/lib/brand-logo.ts` only if a PDF-safe logo reader is needed
- Modify: `package.json` and `package-lock.json` to declare `sharp` directly for WebP conversion and SVG-to-PNG QR rendering
- Reference: `src/lib/settings.ts`, `src/lib/branding.ts`, `src/lib/services/seal-identity.ts`

**Interfaces:**
- Consumes: the verification token from Task 1, current `Branding`, and current audit rendering helpers.
- Produces: `renderFinalizedEnvelopePdf` and certificate rendering that receive a verification URL and render a brand-colored audit page with the QR.

- [ ] **Step 1: Thread branding and verification URL into PDF rendering**
  - Pass app URL, product/organization name, brand color, and logo bytes to the render layer without making an HTTP request back to the same app.
- [ ] **Step 2: Render the QR with existing dependencies**
  - Use `uqr` to render SVG and `sharp` to produce a high-resolution PNG for `pdf-lib`.
  - Convert configured WebP logos to PNG; embed PNG/JPEG logos directly and retain name/color branding if a logo conversion fails.
- [ ] **Step 3: Add the audit page before the install seal**
  - Enable `includeAuditTrail` for SignuDoc-managed finalization, append the QR and human-readable URL, then run the existing `seal(pdfDocument, "signed-document")` path.
  - Redact recipient-visible IP/user-agent audit fields and do not print the signed PDF's own hash on that page; it is available on the verification route and separate certificate.
- [ ] **Step 4: Preserve signer-provided PAdES content**
  - Do not rewrite `signedRevision`; place the branded QR and URL on the separately generated internal and recipient certificates instead.
- [ ] **Step 5: Review rendering paths**
  - Inspect page pagination, QR quiet zone/contrast, logo format fallback, hosted branding, and PAdES byte-preservation path.
- [ ] **Step 6: Commit**

```bash
git add src/lib/services/pdf-finalize.ts src/lib/brand-logo.ts package.json package-lock.json
git commit -m "feat: add branded audit pages to finalized PDFs"
```

### Task 3: Add the public envelope verifier and connect the upload fallback

**Files:**
- Modify: `src/lib/verify.ts`
- Create: `src/app/api/verify/envelope/[token]/route.ts`
- Create: `src/app/verify/envelope/[token]/page.tsx`
- Create: a focused client view under `src/components/verify/` if needed
- Modify: `src/app/verify/page.tsx` and `src/components/verify/verify-form.tsx` only for navigation and explanatory copy
- Reference: `src/app/api/verify/route.ts`, `src/lib/security/route-controls.ts`, `src/components/layout/public-document-shell.tsx`

**Interfaces:**
- Produces: `verifyEnvelopeToken(token: string): Promise<PublicEnvelopeVerification | null>`.
- Public response fields: `title`, `status`, `completedAt`, `signerCount`, and `signedPdfSha256`; never `envelopeId`, signer names/emails, IP addresses, or event details.

- [ ] **Step 1: Add token-hash lookup**
  - Query only completed envelopes by SHA-256 token hash; return the minimal public view.
- [ ] **Step 2: Add a rate-limited public route**
  - Reuse route-control helpers and return a generic not-found response for absent or ineligible tokens.
- [ ] **Step 3: Add the branded verification page**
  - Resolve the bearer URL, show a clear record match and the recorded signed-PDF hash, and explain the scope of the check.
- [ ] **Step 4: Link upload fallback from the QR page**
  - Keep local browser hashing and current SHA-256 API behavior; say upload verifies an exact stored artifact match.
- [ ] **Step 5: Review public data exposure and cached behavior**
  - Ensure the token response is not cacheable and the public page contains no internal envelope ID or private audit data.
- [ ] **Step 6: Commit**

```bash
git add src/lib/verify.ts src/app/api/verify/envelope src/app/verify/envelope src/components/verify src/app/verify/page.tsx src/app/api/verify/route.ts
git commit -m "feat: add public envelope verification links"
```

