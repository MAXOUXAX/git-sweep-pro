# FUTURE — Git Sweep Pro roadmap

This roadmap follows a **tests-first** strategy.

## 1) UX refinements

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

## 2) Manifest and marketplace discoverability

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

1. UX summary + selection helpers
2. Marketplace metadata and docs polish

---

If helpful, this roadmap can be converted into GitHub issues with acceptance criteria.
