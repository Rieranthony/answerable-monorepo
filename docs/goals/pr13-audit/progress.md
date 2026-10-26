# Pull request 13 audit: progress

## 2026-10-26

- The owner asked for an audit of the pull request once M9 has landed, with the plan in files and the report before any code changes.
- Wrote `task_plan.md` and `findings.md`, and measured the pull request before M9 (`findings.md`, Baseline).
- The owner confirmed the scope: PR #13 and what it reshapes, not the whole repository.
- M9 is running in the worktree. The audits start once it has been reviewed and committed.
- **M9 committed and pushed** as 7ffd16b4. The coordinator's gates were all green, and the acceptance, run alone, gave 69 pass in 150 s. The post-M9 baseline and M9's open items are in `findings.md`.
- **The six audits (A to F) started** on 7ffd16b4, each an Opus agent, read-only, working from `auditor-brief.md`. Their reports go to the session scratchpad, under `pr13-audit/<letter>/report.md`.
- **All six audits reported** (A 12, B 11, C 17, D 19, E 13, F 18 findings). With M9's six open items and the overlaps merged, that is 83 distinct findings. Every finding is recorded in `findings.md` with how it was checked.
- **Reproduced by this session:**
  - the role switch across MCPs (B2);
  - the empty-value rule (A2).
- **Measured by this session:** the test gate with 50 and with 100 generated MCPs (F18). It passes at 50 and fails at 100 with `too many clients`. All 150 MCPs were dropped afterwards.
- **The report,** `report.html`, is published as https://claude.ai/artifact/WadRa6EXTco4AxzsFPPt8y. It holds 11 defects to fix, 7 decisions for the owner, the recommended cleanups and the proposals recommended against.
- **The owner decided:**
  - D-1: one process;
  - D-2: keep the `own` mode, against the recommendation;
  - D-3: grants;
  - everything else as recommended.

  Recorded in `decisions.md`.
- **The six audit reports** are copied into `audits/`. The briefs R1 to R6 are written in `briefs/`. R1 starts.

- **R1, the defects,** by Opus. All eleven are fixed, each with a test that failed first.
  - **A4:** `ID_HOST`, loopback unless the image sets `0.0.0.0`.
  - **C3:** readiness fails only on the server's own database. MCP databases are reported within 250 ms.
  - **F18:**
    - `mcp:test` runs through Turborepo with `--concurrency=4`, its cache off, `--continue` and `--env-mode=loose`.
    - Measured: 200 generated MCPs pass, 2,225 tests in 46.6 to 52.0 s, at no more than 15 connections. Cap 16 times out from CPU load. CI's runner has 4 vCPUs.
  - **F1:** the local path's prerequisites.
  - **F2:** an unserved MCP's dependency is dropped (proven by deleting 100 MCPs).
  - **F3:** one rule for organisation filtering.
  - **C5:** in the Toolbox only. Done in the SDK, it would make the admin MCP read ID for an outsider's refused call, which its test forbids.
  - **D11, A8, F11:** the lockfile also had `packages/acceptance` stale.
  - **E12, E13, F13, M9's status lines.**
  - **Also fixed,** outside the audit: the CLI end-to-end test failed about 1 run in 16 on the sort order of its roles.
  - **The agent's gates:**
    - `mcp:test`: 1,025 pass;
    - ID: 1,493, at 100%;
    - the acceptance: 69;
    - kind: 123;
    - web: 120;
    - knip clean.
- **The coordinator's review of R1:** the diff matches the brief. The gates:
  - frozen install unchanged;
  - typecheck and lint forced: 21 of 21;
  - build: 2 of 2;
  - `mcp:test` on the new runner: 14 of 14 tasks in 29 s;
  - web: 120;
  - knip clean;
  - `infra:check` passed.
