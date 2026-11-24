---
name: project_search_reindex
description: "ACME-377 nightly search reindex moved off the primary database to the replica; done"
metadata:
  type: project
  status: done
  modified: 2026-10-02T09:00:00.000Z
---

**2026-10-02.** The nightly reindex now reads from the replica; primary CPU at 03:00 dropped from 90% to 35%.
Merged and released; nothing left.
