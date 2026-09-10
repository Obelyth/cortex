# Cortex roadmap

This release targets a self-managed, single-tenant Cortex deployment. It is not a hosted multi-tenant service. The [README](README.md) describes installation and current capabilities; open [issues](https://github.com/Obelyth/cortex/issues) track implementation work.

## Current foundation

- A private Git-backed Markdown corpus, bounded context assembly and citation verification.
- Trusted read/write MCP access and a separate scoped guest ask/proposal boundary.
- A shared working-context editor, explicit project-free state and bounded project handoff.
- Ops, Overview, Ask, Trends and Settings in the same dashboard.
- Optional database mirror and persistent working state, with fresh-install safeguards.
- Confirmed checks, migrations and deployments once the owner grants the required provider permissions.

No deployment inherits another user's recall measurements, provider readiness or successful alert delivery. Those must be established against that deployment's own configuration and corpus.

## Next priorities

1. Continue measuring retrieval quality and context cost as real corpora grow. Keep frozen evaluations and regression cases with each change.
2. Make first-time setup easier without hiding external account ownership, billing, permissions or database-administration boundaries.
3. Expand diagnostics and actionable explanations inside the dashboard. A present key is not proof that a service works.
4. Improve continuity across compatible clients while preserving explicit trust boundaries and context budgets.

Named collaborator permissions, a standalone verifier package and hosted service options remain future work, not promises included with this install. New retrieval strategies should earn their cost through measured gains before becoming defaults.
