# Branded Evidence and Field Tools Design

## Intent

Improve the experience around sending, preparing, and verifying signed documents. Organization branding should carry through email and signed-document evidence. Senders should be able to place repeated fields quickly, and the completed-envelope screen should use its available width well.

## Goals

- Use configured logo and brand color consistently in outgoing HTML email while preserving plain-text alternatives and legal footer content.
- Add a branded audit-trail page to SignuDoc-managed finalized PDFs before the install applies its final cryptographic seal.
- Put a QR code and stable public verification URL on that page.
- Let a recipient verify an envelope from its public link, or upload a PDF to compare its SHA-256 against recorded SignuDoc artifacts.
- Preserve signer-provided PAdES signatures; do not rewrite their signed document contents to add a final audit page.
- Let senders repeat a placed field across pages and copy/paste multiple selected fields.
- Fix the completed-envelope header so long titles and action buttons remain readable at narrow and wide viewports.

## Non-goals

- Publicly expose signer email addresses, private envelope details, or an unredacted event log through the QR route.
- Claim that a hash match alone proves a PDF's cryptographic signer certificate is trusted or unrevoked.
- Rewrite signer-provided PAdES signed revisions to insert content after their signatures.
- Change signing order, field semantics, required-field validation, or storage providers.

## Constraints

- SignuDoc is a Next.js App Router application; follow the installed Next.js 16 guides before editing route handlers or client components.
- Email must retain a text body and render with table-based, inline styles that work in common email clients.
- Use the configured brand color and logo when available; preserve existing default and hosted-mode branding behavior.
- The verifier must not depend on the envelope's internal database ID being secret.
- QR content must not contain the final PDF hash: adding the QR page changes that hash.
- Signer-provided PAdES signatures must remain intact.
- Do not add a QR dependency; `uqr` is already present.

## Approaches

### Email branding

1. Update every email template independently. This allows bespoke designs but duplicates layout rules and makes consistent branding harder to maintain.
2. Add a shared branded email frame around current template bodies. This centralizes the logo, accent color, spacing, and footer while preserving each email's existing content. **Chosen:** the shared frame, because all user email flows already pass through `withUserEmailLegalFooter`.

### PDF evidence and verification

1. Append a page after every signature is created. This is incompatible with signer-provided PAdES revisions because rewriting signed content can invalidate signatures.
2. For SignuDoc-managed signatures, append the branded trail and QR while rendering the final PDF, then apply the final seal. Keep signer-provided PAdES output unchanged and retain its separately generated certificate. Resolve QR links through an unguessable public token, and keep upload verification hash-based. **Chosen:** this follows the existing finalization split and avoids a self-referential hash.
3. Use the internal envelope ID in a public route. This is simpler, but ties public access to an identifier used throughout the application and is more susceptible to enumeration if IDs become predictable or leak elsewhere.

### Field tools and envelope header

1. Implement only repeat-across-pages or only multi-field clipboard actions. Either leaves one of the requested workflows unavailable.
2. Implement both: repeat a field at the same normalized position on selected/all pages; copy and paste selected fields as a group while preserving relative positions and creating new field IDs. **Chosen:** both workflows, because the user explicitly approved both.

For the completed-envelope header, keep the title/status block at full available width and place actions in a separate wrapping region. This prevents the action group from squeezing long titles into a narrow column, as shown in the supplied screenshot.

## Design

### Shared branded email layout

Extend the shared email wrapper used by invitations, reminders, completion notices, authentication messages, and other account-facing email. Render a consistent outer container, branded header/accent using `Branding.brandColor`, organization/product name, and logo where configured. Keep the existing legal/contact footer and text-body behavior. Do not require remote CSS or images beyond the logo URL already used today. Check contrast for brand-color buttons and links, with a readable fallback color when the configured color is too light.

### Signed PDF trail and public verification

For SignuDoc-managed finalization, enable the existing audit-trail rendering path in `renderFinalizedEnvelopePdf`. Render recipient-safe audit pages with organization name, logo, and brand color, and include a QR that points to a URL shaped like `${APP_URL}/verify/envelope/${token}`. Add the audit pages before `seal(pdfDocument, "signed-document")`; calculate and persist the final PDF hash only after the QR page has been added and the seal operation has completed. Redact private network and user-agent details as the recipient certificate already does.

Create a random, high-entropy public verification token for completed envelopes and store only a hash of it. The route resolves the token hash and returns a minimal public record: whether the envelope is completed, its title, completion date, signer count, and the recorded signed-PDF hash. It must not expose signer contact details or the private event stream. Unknown, deleted, or non-public records return a generic not-found result.

The existing upload verifier remains the fallback: the browser hashes the uploaded PDF locally and submits only the hash. An exact match identifies a stored signed PDF or certificate. Make the page explain that this confirms an exact recorded artifact match; it is not a generic third-party certificate trust checker. A separate cryptographic PDF-signature validation feature is out of scope unless a future design explicitly adds it.

For envelopes finalized from signer-provided PAdES revisions, do not rewrite the signed content to add the final audit page. Keep the current recipient/internal certificate artifacts and ensure the certificates carry the same branded verification URL and QR where they can be rendered without modifying the signer document.

### Field repetition and group copy/paste

In the preparation screen, provide an action to repeat the selected field on chosen pages or all pages. Preserve signer assignment, field type, required/optional state, and normalized displayed coordinates; create a fresh field ID per copy. If a target page is smaller, keep the field inside that page's bounds.

Support selection of multiple fields and group copy/paste with visible controls and standard keyboard shortcuts where they do not conflict with browser behavior. Pasted fields retain relative spacing and properties, receive new IDs, and land on the active page with a small offset so the new group is visible. Preserve the source fields. Undo/redo is not part of this change.

### Completed-envelope header

Restructure the detail header so the document title and status occupy the full content width above a responsive action area. Let actions wrap into rows on medium screens and stack cleanly on mobile; keep primary actions visually distinct and maintain accessible focus order. Do not make the title column shrink to accommodate a single unwrapped action row.

## Privacy and integrity behavior

- Public verification URLs are bearer links. The token must have at least 128 bits of cryptographic entropy; use 256 bits unless the existing token helper provides an equally strong generator.
- Hash tokens before storing them, and rate-limit public token lookups.
- Do not include emails, IP addresses, authentication information, or unredacted event details in the public verification response.
- The QR URL identifies the envelope record; it does not claim to prove the current PDF's bytes. Upload verification performs the byte-for-byte SHA-256 match.
- Do not modify signer-provided PAdES content after signing.

## Builder decisions

- Whether the public token is generated when an envelope is completed or earlier in the signing flow; it must be available to the final PDF renderer and remain stable across retries.
- How the email frame handles dark/light brand colors and client-safe CTA styles, using existing color utilities.
- How the page-selection and multi-field selection controls fit the current preparation UI patterns.
- How verification token migration/backfill handles already-completed envelopes; existing envelopes may remain verifiable by uploaded-file hash without a token.
- Whether the existing certificate download links should display the public verification URL in addition to embedding it.

## Acceptance criteria

- Every outgoing email that uses the shared wrapper shows configured branding consistently and retains its text version, legal links, and fallback behavior.
- SignuDoc-managed signed PDFs include a branded audit trail and QR before final sealing; the QR resolves to a minimal public verification record.
- A QR route does not disclose internal envelope IDs, contact data, or unredacted audit events.
- Upload verification reports an exact artifact match only when the local file hash matches a stored digest.
- Signer-provided PAdES document bytes are not rewritten to add a trail page.
- Senders can repeat a field across pages and copy/paste groups without overwriting source fields or duplicating field IDs.
- The envelope title and actions remain readable at the viewport sizes represented by the supplied screenshot and at mobile widths.
