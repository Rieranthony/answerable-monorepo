# Progress

## 2026-10-06

- Read: all migrations, the Drizzle schema (14 modules), docs/00, 02, 04, the migrators, `test-migrations.ts`, `migration-catalog.*`, `runtime-role.ts`, `isolation.ts`, `client.ts`, mcp-postgres `evidence.ts`, `intents.ts`, `intent-evidence.ts`, the Toolbox's SQL call sites.
- Set up planning files and the throwaway Postgres containers; wrote the agent briefs; dispatched audits A–D (Opus).
- Audits A, B, C hit a transient API network outage and stopped; resumed from their transcripts. D still running.
- Audit D in (Toolbox, mcp-postgres, admin MCP). Docker VM disk hit 100% during D's last rerun (58.4 GB, images 31.8 GB of which 22.9 reclaimable, build cache 8 GB, 13 stopped containers of other projects 2.7 GB). Lowered max_wal_size to 64 MB in audit-pg-a..c; build-cache prune refused by the permission classifier, left to the owner. ~500 MB free.
- Audit B in. Coordinator reproduced the temp-table shadowing bypass (probe 10) as answerable_id_runtime on audit-pg-b and confirmed pg_temp precedence under SET search_path = pg_catalog, public.
- Audit C in. Three of four audits done; A outstanding.
- Audit A in. All four audits done. Consolidation started: re-measuring B's probes 04 and 08 on the quiet host; spot-checking A's claims; investigating the one deterministic test failure.
- Quiet-host re-measurement of B's probes 04 and 08 recorded; same shape as the loaded numbers. One deterministic test failure on this machine investigated as far as environment; cause not found, CI green.
- Report v1 published: https://claude.ai/artifact/8Nb5XhGQz472qjLLpvXLRa. Decisions D1–D12 put to the owner. Containers audit-pg-a..d left up for re-runs.
- Owner took D1–D12 as recommended (AskUserQuestion). Implementation order written into task_plan.md phase 5; starts on the owner's word (the brief said report, do not code yet).
