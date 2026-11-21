# Branded Email Layouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Give outgoing user emails a consistent layout using the configured organization logo and brand color.

**Architecture:** Extend the existing shared email wrapper rather than redesigning every individual message. Keep each message's copy and text alternative, and retain the existing legal footer and hosted-mode behavior.

**Tech Stack:** TypeScript, HTML email fragments, existing Branding utilities.

**Spec:** `docs/superpowers/specs/2026-11-20-branded-evidence-and-field-tools-design.md`

## Global Constraints

- Use configured logo and brand color when available; preserve existing default and hosted-mode branding behavior.
- Email must retain a text body and render with table-based, inline styles that work in common email clients.
- Do not require remote CSS or images beyond the logo URL already used today.
- Do not add or run tests unless the user requests testing or verification.

## Review Focus

- Hosted mode must not inherit an install's logo or color.
- Missing brand color and logo must preserve readable default email layout.
- Brand colors must retain readable text contrast for action links.
- Logo and brand-derived values must remain escaped in HTML.
- Plain-text recipients must retain the original body and legal/contact footer.

---

### Task 1: Add a shared branded email frame

**Files:**
- Modify: `src/lib/services/email-legal-footer.ts`
- Modify: `src/lib/services/email-legal-footer.test.ts` only if the user later requests tests.
- Reference: `src/lib/branding.ts`, `src/lib/brand-color.ts`

**Interfaces:**
- Consumes: `withUserEmailLegalFooter(input, branding, env)` and `Branding`.
- Produces: the same `EmailBodyContent` result shape with consistent header/frame/footer; no caller signature changes.

- [ ] **Step 1: Map the current wrapper behavior**
  - Trace hosted, neutral-install, missing-logo, and footer branches. Confirm all user-facing mail builders route through this wrapper.
- [ ] **Step 2: Add the email-safe frame**
  - Preserve `withUserEmailLegalFooter(input, branding, env)`.
  - Render one table-based container with a thin brand-color accent, the current logo header, the original message body, and the existing footer.
  - Use `buildBrandPalette` from `src/lib/brand-color.ts` for readable, normalized accent colors; keep fallback styling when color is null.
  - Keep textBody construction unchanged.
- [ ] **Step 3: Review all wrapper call sites**
  - Inspect invitation, reminder, completion, authentication, renewal, and account emails for layout assumptions that conflict with the new outer frame.
  - Adjust only caller markup that prevents the shared frame from rendering correctly.
- [ ] **Step 4: Review the change**
  - Inspect rendered HTML strings for nested-document markup, unescaped values, missing text alternatives, and hosted-mode branding leakage.
- [ ] **Step 5: Commit**

```bash
git add src/lib/services/email-legal-footer.ts src/lib/signing.ts src/lib/services/signing-invitation-email.ts src/lib/reminders.ts src/lib/download-renewal.ts src/lib/envelopes.ts src/lib/account.ts src/lib/auth/server.ts
git commit -m "feat: apply system branding to outgoing emails"
```

