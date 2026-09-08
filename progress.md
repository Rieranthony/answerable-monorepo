# Enterprise foundation planning progress

Planning-only task. Read the existing evidence report, design and source. Read planning-with-files skill and checked session catchup (no recovered changes). Consulted Lee Robinson's documentation principles, PostgreSQL row security documentation and OAuth security BCP. Asked one optional product question about identity retention after erasure.

Completed the proposed specification at docs/05-id-enterprise-foundation.md, covering F0–F7 slices, explicit acceptance tests, migration/rollback, provider seams and documentation requirements. Linked it from docs/02-plan.md and docs/03-answerable-id.md. Updated docs/04-answerable-id-schema.md to distinguish observed machine issuance/admin checks and known audit/session limitations from planned guarantees. No runtime behaviour changed.

Validation complete: all relative file/anchor links in the four touched design documents resolved; git diff --check passed. The specification includes explicit proposed status and does not claim new tests pass. Existing 1,144-pass result is historical evidence from the review. Planning completed; implementation remains pending. Identity retention is an explicit product gate, not silently assumed.
