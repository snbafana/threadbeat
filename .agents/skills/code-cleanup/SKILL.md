---
name: code-cleanup
description: Reduce code bloat, flatten abstractions, and remove unnecessary indirection in TypeScript projects. Use when asked to clean up, simplify, reduce abstractions, remove bloat, or flatten a codebase.
disable-model-invocation: true
---

- Read every file before cleanup; preserve behavior while deleting dead code and needless indirection.
- Prefer functional TypeScript: module constants, direct data, no one-off env helpers, and no one-implementation interfaces.
- Inventory files/imports first, then simplify bottom-up from leaf modules toward the entrypoint.
- After long cleanup threads, update and reload this skill with durable rules the user repeated.
