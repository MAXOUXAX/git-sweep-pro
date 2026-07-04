# FUTURE — Git Sweep Pro roadmap

This roadmap now follows a **tests-first** strategy.

## 0) Baseline quality gate (completed)

### Status
✅ Completed in this iteration.

### Delivered
- Comprehensive unit test suite for:
  - stale-branch parsing logic
  - execution mode resolution logic (`Dry Run`, safe delete, force delete)
  - malformed input and whitespace/unicode edge cases

### Why this matters
Future refactors (hardening command execution, parsing upgrades, UX changes) can now be implemented with confidence and protected against regressions.

---

## 1) Robust stale-branch detection

### Why
`git branch -vv` is human-readable output and can vary by Git/version/localization. Structured refs are more stable to parse.

### Proposed work
- Migrate branch discovery to structured Git ref output.
- Keep behavior: only tracked branches with upstream marked as gone are candidates.
- Add/extend tests for structured parsing edge cases.

### Success criteria
- Detection is format-stable and deterministic.
- Existing expected behavior remains unchanged for users.

---

## 2) Multi-root workspace support

### Why
In a multi-folder workspace, users should explicitly choose the repository to clean.

### Proposed work
- Detect all workspace folders that are Git repositories.
- If more than one is available, prompt users to select a target repository.
- Persist the last selected repository per workspace session.

### Success criteria
- No ambiguity when multiple repositories are open.
- The selected repository is clearly displayed in progress and output logs.

---

## 3) Safety controls via settings

### Status
✅ Completed.

### Delivered
Added extension settings:
- `gitSweepPro.defaultMode`: `dryRun | safeDelete | forceDelete`
- `gitSweepPro.protectedBranches`: glob patterns (e.g. `main`, `develop`, `release/*`)
- `gitSweepPro.autoFetchPrune`: boolean
- `gitSweepPro.confirmBeforeDelete`: boolean

Protected branches are filtered out of deletion candidates in the sweep and
post-pull-request flows, glob matching lives in a pure, unit-tested helper, and
the behaviour is covered by unit tests plus a real E2E protected-branch case.

---

## 4) UX refinements

### Why
Small UX upgrades make destructive operations feel more trustworthy.

### Proposed work
- Add summary preview before deletion:
  - total detected
  - selected count
  - mode (`dry run`, `-d`, `-D`)
- Add quick actions in picker flow:
  - select all
  - clear all
  - invert selection
- Improve post-run notification with detailed counts:
  - deleted
  - skipped
  - failed

### Success criteria
- Users understand exactly what will happen before they confirm.
- Outcome details are clear and actionable.

---

## 5) Manifest and marketplace discoverability

### Why
Better metadata improves findability and trust in marketplaces.

### Proposed work
- Improve `package.json` metadata:
  - `keywords` (git, branch, cleanup, prune, scm)
  - richer command titles/descriptions
  - category review
- Expand `README.md` with:
  - examples/screenshots
  - safety model explanation
  - troubleshooting section
- Keep `CHANGELOG.md` strictly versioned and meaningful.

### Success criteria
- Clear value proposition in first glance.
- Easier discovery by relevant search terms.

---

## Suggested implementation order

1. ~~Robust stale-branch detection~~ ✅
2. ~~Safety settings (`protectedBranches`, confirmation options)~~ ✅
3. Multi-root repository selection
4. UX summary + selection helpers
5. Marketplace metadata and docs polish

---

If helpful, this roadmap can be converted into GitHub issues with acceptance criteria.
