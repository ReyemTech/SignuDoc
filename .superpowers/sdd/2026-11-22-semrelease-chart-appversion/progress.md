# SDD ledger — plan: docs/superpowers/plans/2026-11-22-semrelease-chart-appversion.md
Pre-flight: no shared interfaces
Task 1: complete (commits d822aba..94b720a, tests: npm test → ℹ duration_ms 15178.856416)

## Review and fix pass

- Important finding fixed: chart appVersion sync now runs only when a code release is included. Regression test reproduced and passed after fix; workflow-only catch-up preserves locally managed Chart.yaml metadata.
- Coverage gaps fixed: test asserts release commit changes only appVersion, preserves chart version, and updates appVersion on a subsequent 0.3.0 code release.
- Focused update-workflow tests: 14 passed.
- Full suite: 530 passed, 2 skipped, 0 failed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 9 existing warnings.
- `node charts/signudoc/tests/validate.mjs`: passed; Helm reports only the existing recommended-icon notice.
- Chart packaging smoke test: passed; packaged chart reports appVersion 0.9.0.
- `git diff --check`: passed.
