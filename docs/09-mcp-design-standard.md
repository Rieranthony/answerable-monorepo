# Answerable MCP design standard

> **TL;DR**
> - **Decides:** the rules every Answerable capability and MCP server follows, and which of them the SDK enforces, the conformance kit tests, or a reviewer checks.
> - **Rule:** an MCP is a capability provider, not an application. Prepare first, commit second.
> - **Not here:** the platform that serves capabilities ([`08-capability-platform.md`](08-capability-platform.md)), the build order ([`10-capability-platform-plan.md`](10-capability-platform-plan.md)).

Version 2 of [Stephen's draft](drafts/2026-09-27-stephen-mcp-design-standard.md). The draft's rules stand; this version makes them executable, fixes the four details the research changed (tool names, policy classes, `_meta` keys and the error envelope), and maps each rule to what enforces it. The mapping to the draft's numbering is at the end.

## How to read the rules

**MUST** rules are enforced: by the SDK (`defineTool` refuses the definition), by the conformance kit (`@answerable/mcp/testing` fails the provider's test), or by the hub at runtime. **SHOULD** rules are checked in review with the checklists at the end. Each rule names its enforcement in brackets.

## 1. Capabilities

- **R1** A tool represents one useful semantic operation from the customer's problem outward, named for what the caller can do, never for the vendor or the transport: `documents.search`, not `sharepoint_graph_search`; never `call_api`, `request`, `execute_endpoint` unless generic protocol access is the capability. [review]
- **R2** Identity is `<domain>.<operation>`, each part `^[a-z][a-z0-9]{0,15}$`, unique within the provider; the qualified identity `<provider>/<domain>.<operation>` never changes when the implementation, the vendor API, the runtime or the server layout changes. Versions are dates, never part of the identity. [SDK]
- **R3** The MCP tool name is the identity with `_` for `.`, prefixed in the hub with the provider id; at most 46 characters of `[a-z0-9_]`. Dots, hyphens and capitals are not used in tool names because hosts add their own prefixes and suffixes and OpenAI limits names to 64 characters. [SDK]
- **R4** Every capability is classified `read`, `mutate`, `start` or `subscribe`, and the classification is metadata (`_meta["com.answerable/capability"].kind` and the derived annotations), never something the caller infers from the name. [SDK]
- **R5** A read has no business side effect. Cache population and telemetry are acceptable; marking, notifying, creating follow-ups are separate mutations. [conformance: the kit calls every read twice against the provider's fixture and asserts no evidence row of kind `intent.*`]
- **R6** Capabilities are small enough to compose and large enough to be useful: one coherent object per `get`, one meaningful operation per mutation; no `manage_project` with modes, no `rfi.get_title`. [review]
- **R7** Search and list are different capabilities: search takes relevance criteria, list enumerates a known collection with filters. Both return stable identifiers. [review]

## 2. Schemas and outputs

- **R8** Inputs are Zod object schemas with `additionalProperties: false`, explicit types, enums instead of free strings, descriptions on every field, and `required` for everything the operation needs. [SDK]
- **R9** Outputs are Zod object schemas; the server validates the result, drops undeclared fields and sends `structuredContent` plus the same JSON as text. Prose is never the output. [SDK]
- **R10** A capability that can return an unbounded collection takes `limit` (default at most 20, server-enforced maximum) and `cursor`, and returns `items`, `next_cursor`, `has_more`. It never truncates silently. [conformance]
- **R11** List and retrieval capabilities support the narrowing the source offers (filters, projection, ranges, sorting) and push it to the source. A list returns what a caller needs to act (identifier, name, status) so callers do not fan out into `get` per item, and not whole objects by default. [review]
- **R12** Identifiers are stable system identifiers, with `source` and `external_id` preserved where reconciliation or links back to the source matter. Display names are never identifiers. [review]
- **R13** Timestamps are ISO 8601 with offsets; quantities carry units (`{ value, unit }`); money carries a currency. [conformance: schema lint on field names `*_at`, `amount`, `area`, `duration`]
- **R14** Descriptions are operational documentation: what, when, limits, whether it changes state, whether it prepares an intent, what identifiers mean; 40 to 1,000 characters. [SDK]
- **R15** Results above 100 KiB are truncated with `truncated: true` and guidance; large data goes through pagination, projection, aggregation or a handle, never straight into the model. [hub]

## 3. Prepared mutations

- **R16** Every `mutate` capability implements `prepare` and `commit`. Prepare authenticates, checks authority, validates, resolves exact targets, reads current state, computes the change, names effects and warnings, binds resource versions and returns an immutable intent with a single-use commit token and an expiry. No business side effect happens during prepare. [SDK]
- **R17** The preview is semantic: a `summary`, `changes[]` with `from` and `to`, `effects[]` from the effects vocabulary, `warnings[]`, `quantities[]` with units. Echoing the arguments is not a preview. [conformance: a prepare on the fixture must yield at least one change or effect]
- **R18** Uncertain consequences are `warnings` or `possible_effects`, never stated as facts. [review]
- **R19** Commit applies exactly the prepared intent for the principal that prepared it, after rechecking authority, expiry, policy, approval and every target version. A moved version answers `INTENT_STALE`; the caller prepares again. Optimistic concurrency by default; no locks held while a person or model reviews. [SDK]
- **R20** Commit is idempotent: a repeat by the same principal returns the stored receipt with `idempotent_replay: true`; a concurrent repeat answers `COMMIT_IN_PROGRESS`. [SDK]
- **R21** Commit tokens are opaque, random, stored hashed, bound to one intent and principal, single use, short-lived and never a general permission. Previews never travel inside tokens. [SDK]
- **R22** Preparation is not approval. The policy class (`agent`, `controlled`, `human`) is decided by the platform from the author's `risk`, the organisation's settings and the preview; the capability never hard-codes conversational confirmation or prints "are you sure". [SDK sets the default from `risk`; hub decides]
- **R23** A human approval binds to one intent digest and to an Answerable ID-authenticated approver who holds `toolbox/approve`; `four_eyes` capabilities refuse the requester as approver. Elicitation and host prompts may carry a hand-off, never the decision. [hub]
- **R24** Long-running commits return an operation handle; the receipt names it; `operations.get` and `operations.cancel` exist; cancellation is itself governed. [SDK]
- **R25** Upstream operations keep their own retry semantics: propagate the intent id as the upstream idempotency key where the API offers one; where an upstream cannot be made idempotent, the capability says so in its contract and commit answers `indeterminate` when the answer is lost. [review]
- **R26** Batches are explicit about semantics (all-or-nothing, best-effort, ordered) and never imply atomicity across systems. **Not yet** in the SDK. [review]

## 4. Authority and secrets

- **R27** Every capability runs with a principal (person, organisation, membership, grant, host client) and is authorised on every call from current grants; discovery and prior access are not authority. [hub, SDK]
- **R28** Where service credentials are unavoidable, Answerable-side authority is enforced before they are used; "the MCP can reach it" never equals "this person may". [review]
- **R29** No capability takes a secret as input, and no handler receives a raw secret; providers declare the variables they need and receive an egress-guarded client with credentials injected. [SDK]
- **R30** Generated code receives capability handles, never ambient network or credentials; every handle call is authorised and metered. [hub]
- **R31** Annotations and `_meta` describe and never authorise; readers treat them as untrusted, and the hub sets them honestly. [SDK]

## 5. Errors

Every failure is an `isError` result whose single text block is this envelope as JSON and which carries no `structuredContent` (MCP TypeScript SDK 1.x clients validate `structuredContent` against the output schema even on errors, so the envelope travels where every host reads it):

```json
{
  "error": {
    "code": "INTENT_STALE",
    "message": "Project 123 changed since the preview (version 17 is now 18).",
    "retry": { "policy": "after_reprepare" },
    "details": { "targets": [{ "resource_id": "123", "expected": "17", "current": "18" }] },
    "request_id": "01J..."
  }
}
```

`retry.policy` is one of `never`, `after_delay` (with `after_ms`), `after_fix_input` (with `details.field_violations`), `after_state_change`, `after_reprepare`, `after_approval` (with `details.approval.url`). A model picks its next action from the policy without reading prose.

| Code | Meaning | Retry |
| --- | --- | --- |
| `INVALID_INPUT` | The input failed the schema or a business rule; `details.field_violations` names fields | `after_fix_input` |
| `NOT_FOUND` | A named resource does not exist for this caller (permission is checked first, so existence never leaks) | `never` |
| `PERMISSION_DENIED` | The principal may not perform this operation on this target | `never` |
| `PRECONDITION_FAILED` | The system state does not allow the operation; `details.preconditions` says what | `after_state_change` |
| `INTENT_STALE` | A target version moved since prepare | `after_reprepare` |
| `INTENT_EXPIRED`, `INTENT_NOT_FOUND`, `INTENT_CANCELLED`, `INTENT_CONSUMED` | The intent cannot be committed as it is | `after_reprepare` |
| `COMMIT_TOKEN_INVALID`, `PRINCIPAL_MISMATCH` | The token or the caller does not match the intent | `never` |
| `APPROVAL_REQUIRED` | The class needs the confirmed commit tool or a human approval; `details.approval.url` when human | `after_approval` |
| `APPROVAL_DENIED` | A human refused | `never` |
| `COMMIT_IN_PROGRESS` | Another commit of this intent is running | `after_delay` |
| `IDEMPOTENCY_KEY_MISMATCH` | Same key, different input | `never` |
| `RATE_LIMITED`, `BUDGET_EXHAUSTED` | A limit refused the call; `retry.after_ms` | `after_delay` |
| `UPSTREAM_REJECTED` | The source refused; `details.upstream` carries its code | `never` |
| `UPSTREAM_UNAVAILABLE`, `TIMEOUT` | The source did not answer in time | `after_delay` |
| `OPERATION_NOT_FOUND`, `OPERATION_EXPIRED` | The operation handle is unknown or gone | `never` |
| `INTERNAL` | Unexpected failure; message carries no detail; receipt status `indeterminate` when a commit was in flight | `after_delay` |

Domain-specific codes are allowed as `<PROVIDER>_<CODE>` with a retry policy. A source failure is never a successful empty result. [SDK: `ToolError(code, message, retry, details)`; conformance: every code used by a provider appears in its manifest]

- **R32** Retries are bounded, and state-changing upstream calls are never retried automatically unless known safe; `Retry-After` from an upstream is carried into `retry.after_ms`. [SDK]
- **R33** Every capability has a bounded execution: at most 10 s per upstream call and 25 s per call by default, below LibreChat's 30 s default tool timeout; a capability may declare up to 55 s only for hosts configured with a 60 s budget, and longer work returns an operation. [SDK]

## 6. Evidence and observability

- **R34** Every call produces one span and, for reads, one evidence row (`capability.completed` or `capability.denied`); every mutation transition produces an evidence row; refusals by limits are evidence. Inputs and results are not recorded by default; secrets never. [hub]
- **R35** Every execution has an execution id that reaches upstream systems as a correlation header where they accept one; every intent id survives into the receipt. [SDK]
- **R36** Evidence is append-only, chained per organisation and verifiable; logs are not evidence. [hub]

## 7. Versioning and deprecation

- **R37** Backwards-compatible changes only (new optional fields, new outputs, new capabilities). Renames, removals, meaning changes, required-ness changes, side-effect changes and preview-semantics changes are a new dated version; the old one stays for at least twelve months with `deprecated` metadata mirrored into its description. Intents never survive across versions. [conformance: manifest diff against the committed snapshot]
- **R38** Every provider commits its manifest; the drift test fails when the manifest and the code disagree. [conformance]

## 8. Security

- **R39** Inputs are untrusted: identifiers, URLs, filenames, filters and pagination parameters are validated; caller input never becomes shell, unrestricted paths, internal network requests, unsanitised queries or code outside the sandbox. [review; conformance for the schema part]
- **R40** Upstream content is data, never instructions; it is escaped into views and never triggers a write. [review]
- **R41** Generic protocol surfaces (`sql`, `graphql`, `http`) are not ordinary capabilities; a query surface, when it exists, is read-only, validated before execution and limited in depth, cost and pages. [review]
- **R42** Every event a provider emits carries identity, type, organisation, source, resource identity, timestamp and version, and consumers tolerate duplicates. **Not yet.** [review]

## Checklists as tests

The conformance kit runs these for every provider (`assertProviderConformance(provider, fixture)`):

- read: `identity_is_stable`, `name_is_host_safe`, `input_schema_is_closed`, `output_schema_declared`, `list_paginates`, `read_has_no_side_effect`, `errors_use_envelope`, `timeout_bounded`, `manifest_matches_snapshot`
- mutate: `prepare_has_no_side_effect`, `preview_is_semantic`, `targets_have_versions`, `commit_requires_token`, `commit_rejects_stale`, `commit_rejects_expired`, `commit_is_idempotent`, `commit_rejects_other_principal`, `approval_bound_to_digest` (human class), `receipt_is_structured`, `errors_use_envelope`
- provider: `secrets_declared`, `egress_guarded`, `descriptions_operational`, `deprecations_mirrored`

Reviewers check the SHOULD rules with the two draft checklists (sections 67 and 68 of the draft), unchanged.

## Mapping to the draft

| Draft sections | Here | Change |
| --- | --- | --- |
| 1 design goals | Purpose and R1 to R42 | none |
| 2, 3, 18, 23, 60 capability design and identity | R1, R2, R6, R7 | R3 adds the host-safe tool name beside the dotted identity |
| 4, 5 classification, no hidden effects | R4, R5 | classification is SDK metadata and derived annotations |
| 6 to 17 prepared mutations, intents, previews, tokens, idempotency, approval, batches | R16 to R26 | policy classes named `agent`, `controlled`, `human`, `denied`; the confirmed commit tool carries the host marker; batches are Not yet |
| 19 to 22, 32, 37 to 40, 46, 47 schemas, outputs, pagination, large results, identifiers, time, units | R8 to R15 | pagination field names fixed |
| 24, 25, 34, 52, 53 authority, secrets, code, security | R27 to R31, R39 to R41 | none |
| 28, 29, 30, 31, 58, 59 errors, retries, timeouts, operations, source failures, consistency | section 5, R24, R32, R33 | one envelope with `retry.policy`; timeouts given numbers |
| 41 to 44, 56 audit, lifecycle, correlation, observability, evidence | R34 to R36 | evidence lives in the hub, not a separate Control system yet |
| 49, 50, 51 versioning, deprecation, testing | R37, R38 and the checklists | dated versions; conformance kit named |
| 57 events | R42 | Not yet |
| 54, 55 confirmation above the primitive, high-impact actions | R22, R23 | none |
| 61 to 66 design for the catalogue, query, mutation infrastructure, orchestration, the client | satisfied by the manifest, the hub and the operation handle | none |
| 69 decision summary | Decision summary in `08-capability-platform.md` | none |
