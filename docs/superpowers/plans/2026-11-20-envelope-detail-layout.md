# Envelope Detail Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Keep long envelope titles and action buttons readable in the document detail header at desktop and mobile widths.

**Architecture:** Separate the title/status block from the action toolbar so actions wrap below the title instead of shrinking it into a narrow column. Preserve current action conditions, order, and semantics.

**Tech Stack:** Next.js 16 App Router, React, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-11-20-branded-evidence-and-field-tools-design.md`

## Global Constraints

- Keep all current status-specific actions and their behaviors.
- Preserve accessible focus order and visible primary-action hierarchy.
- Do not add or run tests unless the user requests testing or verification.

## Review Focus

- Very long titles must wrap without colliding with action buttons.
- Large action sets must wrap without horizontal overflow.
- The thumbnail must remain useful without consuming the title's minimum width.
- Mobile buttons must remain full-label and easy to tap.
- Status, date, and signature-type labels must continue wrapping independently.

---

### Task 1: Restructure the envelope detail header

**Files:**
- Modify: `src/components/envelopes/envelope-detail-shell.tsx`
- Reference: supplied screenshot of the completed-envelope page

**Interfaces:**
- Consumes: existing `activeRecord`, status flags, and `ShellButton` actions.
- Produces: a full-width title/status section followed by a responsive, wrapping action toolbar; no change to action handlers.

- [ ] **Step 1: Separate title and actions in the header layout**
  - Replace the single competing flex row with a title/status row and a separate action region.
- [ ] **Step 2: Apply responsive wrapping and button sizing**
  - Keep title width unconstrained by action intrinsic widths; wrap actions into multiple rows at intermediate widths and stack cleanly on mobile.
- [ ] **Step 3: Review all status variants**
  - Inspect draft, awaiting-signatures, completed, declined, and voided action groups for order, semantics, and focus sequence.
- [ ] **Step 4: Review responsive layout**
  - Compare against the supplied 1168px screenshot and inspect narrow mobile, tablet, and desktop layout states for overflow and collisions.
- [ ] **Step 5: Commit**

```bash
git add src/components/envelopes/envelope-detail-shell.tsx
git commit -m "fix: make envelope detail header responsive"
```

