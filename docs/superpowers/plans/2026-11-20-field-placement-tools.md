# Field Placement Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Let senders repeat placed fields across pages and copy/paste groups of fields while preparing an envelope.

**Architecture:** Add deterministic copy helpers for field geometry and properties, then expose repeat and group-copy actions in the existing preparation editor. Keep persistence on the existing autosave route and use new IDs for every created field.

**Tech Stack:** TypeScript, React client component, existing normalized PDF field placement model.

**Spec:** `docs/superpowers/specs/2026-11-20-branded-evidence-and-field-tools-design.md`

## Global Constraints

- Preserve signer assignment, field type, required state, and normalized placement when duplicating.
- Every copied field gets a unique ID; source fields remain untouched.
- Keep duplicated fields within target page bounds.
- Do not add or run tests unless the user requests testing or verification.

## Review Focus

- Page copies must retain normalized position on differently sized pages and stay in bounds.
- Duplicating initials must not remove or alter the source field.
- Copy/paste must not overwrite source fields or reuse IDs.
- Radio-button groups must remain logically isolated when copied to another page.
- Keyboard shortcuts must not intercept typing in inputs, textareas, or editable controls.

---

### Task 1: Add field-copy helpers

**Files:**
- Create: `src/lib/utils/field-duplication.ts`
- Reference: `src/lib/schemas/field.ts`, `src/lib/utils/pdf-coords.ts`

**Interfaces:**
- Define `CopyableField` as the persisted placement fields used by the editor plus a required `id`.
- Produce `repeatFieldsOnPages(fields: readonly CopyableField[], targetPages: readonly number[], createId: () => string): CopyableField[]`.
- Produce `pasteFieldGroup(fields: readonly CopyableField[], targetPage: number, createId: () => string, offset: { x: number; y: number }): CopyableField[]`.
- Both helpers preserve normalized geometry, clamp each copied rectangle to `[0, 1]` bounds, preserve choices/labels/signer/required values, and assign fresh radio `groupId` values per copied source group and target page.

- [ ] **Step 1: Define field-copy input and output types**
  - Use existing field placement types; keep UI-only IDs and selection state outside persisted schema fields.
- [ ] **Step 2: Implement repeat and group-copy transformations**
  - Repeat one or more selected fields on selected pages at the same normalized location.
  - Copy a group to an active page with a small normalized offset and bounded positions.
  - Generate fresh field IDs at the call site and assign fresh radio group IDs per copied group where needed.
- [ ] **Step 3: Review edge cases**
  - Check repeated target pages, page size changes, radio groups, option arrays, and source immutability.
- [ ] **Step 4: Commit**

```bash
git add src/lib/utils/field-duplication.ts
git commit -m "feat: add field duplication helpers"
```

### Task 2: Add repeat-across-pages and multi-field copy/paste controls

**Files:**
- Modify: `src/components/envelopes/prepare-live-shell.tsx`
- Modify: `src/components/envelopes/interactive-placed-field.tsx`
- Create: focused dialog/control components under `src/components/envelopes/` if needed
- Reference: `src/app/api/envelopes/[id]/fields/route.ts`

**Interfaces:**
- Consumes: helpers from Task 1 and the editor's existing `fields`, `activePage`, and autosave state.
- Produces: selected field ID set, editor-local copy buffer, repeat-page action, and visible Copy/Paste actions.

- [ ] **Step 1: Add multi-select state and selection controls**
  - Support modifier-click selection on the active page and clear selection when the viewport is clicked outside a field.
- [ ] **Step 2: Add repeat-page controls**
  - Offer selected pages and all pages, skip the source page, and use the helper to append fresh field copies.
- [ ] **Step 3: Add group copy/paste**
  - Keep the clipboard in editor state; add visible controls and Ctrl/Cmd+C and Ctrl/Cmd+V handling outside text-entry targets.
  - Paste onto the active page with a small offset; do not mutate source fields.
- [ ] **Step 4: Connect all operations to existing autosave**
  - Ensure the field request serializer sends only schema-supported field properties and autosaves copied fields through the existing PUT route.
- [ ] **Step 5: Review keyboard, screen-reader, and save-state behavior**
  - Check focus behavior, labels, disabled state while saving, and errors from the current autosave flow.
- [ ] **Step 6: Commit**

```bash
git add src/components/envelopes/prepare-live-shell.tsx src/components/envelopes/interactive-placed-field.tsx src/components/envelopes
git commit -m "feat: repeat and copy placed fields"
```

