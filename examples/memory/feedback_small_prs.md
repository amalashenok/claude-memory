---
name: feedback_small_prs
description: "Keep pull requests small: one concern per PR, refactoring separate from behaviour changes"
metadata:
  type: feedback
---

One concern per pull request; a refactoring goes into its own PR before the behaviour change.

**Why:** reviewers on the team approve small PRs the same day, mixed ones wait for days.
**How to apply:** when a fix needs a refactoring first, propose splitting it into two branches before writing code. See also [[reference_payments_sandbox]].
