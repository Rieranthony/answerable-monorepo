# Answerable MCP Design Standard

## Purpose

Answerable builds and maintains bespoke MCP servers for client organisations.

These MCP servers will connect to different systems, expose different capabilities, and evolve independently. They must nevertheless behave like parts of one platform.

This standard defines the minimum design rules for Answerable MCP servers.

> **Core principle**  
> An Answerable MCP server is a capability provider, not a bespoke mini-application.

Each MCP should expose stable, typed, bounded, composable capabilities that can be used directly today and can later be discovered, governed, queried, and orchestrated through shared capability infrastructure such as Answerable Toolbox.

The MCP must not assume that OmniChat is its only caller.

A capability should be usable by:

- OmniChat;
- another MCP client;
- programmatic agent code;
- Answerable applications;
- durable workflows;
- future Answerable capability infrastructure.

A second foundational rule applies to state-changing capabilities:

> **Prepare first. Commit second.**  
> A mutation should be able to describe the exact change it intends to make before that change occurs.

This gives agents, policy systems, and humans a stable mutation intent that can be inspected before the side effect is committed.

---

# 1. Design goals

Every Answerable MCP should aim to be:

- **discoverable** — another system can understand what it provides;
- **typed** — inputs and outputs have explicit schemas;
- **bounded** — calls have predictable limits on work and output;
- **composable** — capabilities can be safely combined with other capabilities;
- **authorised** — every call runs within explicit user and organisation authority;
- **deliberate** — state-changing actions are prepared before they are committed;
- **retry-safe** — failures and retries have defined behaviour;
- **observable** — important operations can be traced and audited;
- **implementation-independent** — the public capability contract does not expose unnecessary details of the underlying system;
- **context-efficient** — callers can request only the information they need where practical.

---

# 2. Capability design

A tool should represent a meaningful capability.

Prefer:

```text
projects.search
projects.get
rfis.list
rfis.get
rfis.create
documents.search
documents.read
```

over interfaces that simply mirror low-level vendor endpoints.

Avoid tools whose meaning is:

```text
call_api
request
do_action
execute_endpoint
```

unless the MCP itself exists specifically to expose a generic protocol.

The capability name and contract should describe **what the caller can do**, not how the underlying integration happens to implement it.

For example, prefer:

```text
documents.search
```

over:

```text
sharepoint_graph_search
```

unless the distinction between SharePoint and another document source is itself important to the capability.

---

# 3. Stable capability identity

Every capability must have a stable identity.

A capability should keep the same identity when:

- the implementation is refactored;
- the underlying vendor API changes;
- the capability moves to a different runtime;
- the MCP server is reorganised internally;
- the capability later becomes accessible through Answerable Toolbox.

Changing implementation must not unnecessarily change the capability contract.

Names should therefore be semantic and durable.

Preferred pattern:

```text
<domain>.<operation>
```

Examples:

```text
projects.search
projects.get
rfis.list
rfis.create
contacts.find
documents.read
documents.search
```

Nested names can be used where they improve clarity:

```text
projects.members.list
documents.revisions.get
```

Do not encode versions into capability names unless a genuine parallel-version period is required.

Prefer contract versioning and controlled deprecation.

---

# 4. Classify every capability

Every capability must be classified according to its semantics.

At minimum, distinguish:

```text
READ
MUTATE
START
SUBSCRIBE
```

A read retrieves or analyses information without intentionally changing authoritative state.

A mutation changes authoritative state or causes an external effect.

A start capability begins work that will continue asynchronously.

A subscription exposes events or changes over time.

Examples:

```text
READ
  projects.search
  projects.get
  rfis.list
  documents.read

MUTATE
  rfis.create
  projects.update
  emails.send
  documents.delete

START
  exports.start
  document_processing.start

SUBSCRIBE
  project.updated
  document.created
```

This classification must be visible in capability metadata and must not depend on the caller guessing from the name.

---

# 5. Read capabilities must not hide side effects

A capability that appears read-only must not produce hidden business side effects.

For example:

```text
documents.read
```

must not also:

```text
mark document as reviewed
notify owner
create follow-up task
```

unless those effects are explicitly part of the documented contract.

Incidental technical effects such as cache population or telemetry are acceptable where they do not change business meaning.

Business side effects should normally be exposed as separate mutating capabilities.

---

# 6. Prepared Mutations

All meaningful state-changing capabilities should support a two-stage mutation model:

```text
PREPARE
   |
   v
PREVIEW
   |
   v
COMMIT
   |
   v
RECEIPT
```

The prepare stage:

- authenticates the caller;
- checks current authority;
- validates the requested operation;
- resolves the exact target resources;
- reads relevant current state;
- calculates the intended changes;
- identifies known effects and warnings;
- establishes concurrency preconditions;
- creates an immutable mutation intent;
- returns a commit token or equivalent mutation handle.

No business mutation occurs during prepare.

The commit stage:

- authenticates the caller again;
- rechecks authority;
- validates the mutation intent;
- checks expiry;
- checks relevant resource state;
- checks applicable policy;
- applies the exact prepared mutation;
- executes idempotently;
- returns a structured receipt.

The central rule is:

> A commit authorises exactly the prepared mutation. It is not a generic permission to perform some later mutation.

---

# 7. Mutation intent

A prepared mutation must have a stable identity.

Conceptually, the mutation intent should bind:

```text
mutation identity
organisation
principal
capability identity
canonical inputs
resolved target resources
relevant resource versions
expected changes
known effects
policy context
expiry
```

The implementation can use:

- a signed opaque token;
- a server-side mutation record with an opaque handle;
- another equivalent mechanism.

The caller must not be able to:

1. prepare one action;
2. alter its parameters;
3. reuse the resulting token for a different action.

A commit token should mean:

> Apply exactly this previously prepared mutation if its authority and preconditions are still valid.

---

# 8. Mutation previews

A mutation preview must describe the proposed change semantically.

Do not merely echo the request arguments.

Bad:

```json
{
  "tool": "projects.update",
  "arguments": {
    "project_id": "123",
    "status": "archived"
  }
}
```

Better:

```json
{
  "mutation_id": "mut_01K...",
  "summary": "Archive project 'King Street Redevelopment'",
  "changes": [
    {
      "path": "status",
      "from": "active",
      "to": "archived"
    }
  ],
  "effects": [
    "The project will no longer appear in active project searches."
  ],
  "warnings": [],
  "affected_resources": [
    {
      "type": "project",
      "id": "123",
      "version": 42
    }
  ]
}
```

The server understands the domain and should explain the proposed consequence in terms meaningful to the caller.

The model should not have to infer the effect from low-level vendor parameters.

---

# 9. Known and uncertain effects

Not every downstream consequence is fully knowable before execution.

A preview should therefore distinguish where useful between:

```text
changes
effects
possible_effects
warnings
```

For example, an email capability can know:

```text
recipient
subject
body
attachments
sending account
```

but may not be able to guarantee final delivery because organisation mail-flow rules can intervene.

Do not represent uncertain external consequences as guaranteed facts.

---

# 10. Prepared mutation example

A mutating capability might behave conceptually as follows.

Prepare:

```json
{
  "capability": "rfis.close",
  "input": {
    "rfi_id": "123"
  }
}
```

Response:

```json
{
  "mutation_id": "mut_01K...",
  "summary": "Close RFI-123",
  "changes": [
    {
      "path": "status",
      "from": "open",
      "to": "closed"
    }
  ],
  "affected_resources": [
    {
      "type": "rfi",
      "id": "123",
      "version": 17
    }
  ],
  "warnings": [],
  "commit_token": "opaque-token",
  "expires_at": "2026-09-27T14:35:00Z"
}
```

Commit:

```json
{
  "commit_token": "opaque-token"
}
```

Receipt:

```json
{
  "mutation_id": "mut_01K...",
  "status": "committed",
  "capability": "rfis.close",
  "resource": {
    "type": "rfi",
    "id": "123"
  },
  "before_version": 17,
  "after_version": 18,
  "committed_at": "2026-09-27T14:29:03Z"
}
```

---

# 11. Prepared state must not become stale silently

A preview is only valid for the state against which it was prepared.

Suppose the system prepares:

```text
Budget
£100,000 -> £120,000
```

against resource version 17.

Before commit, another actor changes the budget and the resource becomes version 18.

The original mutation must not silently apply as though the preview were still accurate.

The commit should fail with a structured conflict such as:

```text
PREPARED_MUTATION_STALE
```

The caller must then prepare the operation again against current state.

Use optimistic concurrency by default.

Do not hold vendor or database locks while a model, human, or policy system reviews a preview.

---

# 12. Mutation tokens

Mutation tokens or handles should normally be:

- scoped to one organisation;
- scoped to one principal or authorised approval context;
- scoped to one capability;
- bound to one immutable mutation intent;
- short-lived;
- resistant to tampering;
- safe to retry;
- non-transferable unless explicitly designed otherwise.

A token must not become a general bearer capability for arbitrary mutations.

Where practical, avoid placing sensitive business data directly inside a client-visible token.

An opaque token backed by server-side prepared state can be preferable when previews contain sensitive or complex information.

---

# 13. Commit must be idempotent

Commit operations must be safe to retry.

For example:

```text
commit(token)
     |
     v
mutation applied
     |
     X response lost
```

A second call:

```text
commit(token)
```

should return the existing receipt rather than apply the mutation again.

Conceptually:

```text
mutation token
     |
     v
immutable mutation identity
     |
     v
at-most-one business effect
     |
     v
repeatable receipt retrieval
```

This is preferable to making the caller distinguish between:

```text
commit never reached server
```

and:

```text
commit succeeded but response was lost
```

---

# 14. Preparation is not approval

Prepared mutations create a deliberate execution boundary.

They do not by themselves create independent approval.

If the same AI:

```text
requests mutation
      |
      v
reads preview
      |
      v
commits mutation
```

the second step provides useful protection against:

- accidental tool selection;
- incorrect parameters;
- unexpected target resolution;
- surprising effects;
- stale state.

However, it is not independent human authorisation.

Use distinct terminology:

```text
prepare
review
commit
```

Reserve words such as:

```text
approve
authorise
consent
```

for cases where an actual human, policy authority, or separate authorised actor is involved.

---

# 15. Commit policy

Every prepared mutation can use the same technical protocol while policy determines who may commit it.

Typical policy classes are:

```text
AGENT-COMMITTABLE
CONTROLLED
HUMAN-APPROVAL-REQUIRED
```

For example:

```text
rename internal draft
    -> agent may commit

create internal CRM task
    -> agent may commit

send external email
    -> policy dependent

delete authoritative project
    -> human approval required

approve financial payment
    -> separate authorised human authority
```

The capability itself should not hard-code conversational approval behaviour.

The policy layer decides whether the current actor has authority to commit the prepared mutation.

---

# 16. Human approval

Where human approval is required, the human should approve a specific prepared mutation.

Prefer:

```text
prepare
   |
   v
immutable mutation intent
   |
   v
human sees exact preview
   |
   v
human approves mutation_id
   |
   v
commit
```

over:

```text
AI: "Can I update the project?"
Human: "yes"
AI later performs some update
```

Approval should be bound to:

- the exact mutation;
- the exact resources;
- the relevant state;
- the approving identity;
- the validity period.

If the mutation becomes stale, the approval should normally become stale with it.

---

# 17. Batch mutations

Programmatic work may prepare many related mutations.

Tooling should support a batch preview where useful.

For example:

```json
{
  "batch_id": "batch_123",
  "summary": "Update 17 overdue RFIs",
  "mutation_count": 17,
  "changes": {
    "status_updates": 17
  },
  "warnings": [],
  "commit_token": "opaque-token"
}
```

A batch must still identify its constituent mutations and affected resources.

Batch commit semantics must be explicit.

Do not imply atomicity across external systems unless actual atomicity exists.

A batch may define:

```text
all-or-nothing
best-effort
ordered
independent
compensatable
```

but the behaviour must be clear.

---

# 18. Prefer composable capabilities

Capabilities should be small enough to compose, but not so small that the caller has to reproduce the vendor API one field at a time.

Prefer:

```text
projects.search
rfis.list
rfis.create
```

over one giant tool:

```text
manage_project
```

that contains dozens of unrelated modes.

Also avoid excessive fragmentation such as:

```text
rfi.get_title
rfi.get_due_date
rfi.get_owner
rfi.get_status
```

when:

```text
rfis.get
```

can return a coherent RFI object.

The aim is:

> **One capability should represent one useful semantic operation.**

Composition belongs above individual capabilities.

---

# 19. Input schemas are contracts

Every tool input must have an explicit schema.

Schemas must be:

- precise;
- minimally permissive;
- well described;
- stable where practical;
- safe to validate automatically.

Use explicit types.

Prefer:

```json
{
  "type": "object",
  "properties": {
    "project_id": {
      "type": "string",
      "description": "Stable project identifier."
    },
    "status": {
      "type": "string",
      "enum": ["open", "closed"]
    }
  },
  "required": ["project_id"],
  "additionalProperties": false
}
```

over:

```json
{
  "type": "object"
}
```

Avoid free-form strings where an enum or structured object is appropriate.

If the server needs a value to perform the operation correctly, require it.

---

# 20. Output schemas matter equally

A tool must not treat its output as arbitrary prose.

Where practical, capabilities should return structured data with an explicit output schema.

Prefer:

```json
{
  "rfi": {
    "id": "RFI-102",
    "subject": "Roof drainage detail",
    "status": "open",
    "due_at": "2026-10-14T12:00:00Z"
  }
}
```

over:

```text
RFI RFI-102 is called Roof drainage detail and is currently open.
It is due on 14 October.
```

Human-readable explanation can be included when useful, but it should not replace structured output.

Structured outputs enable:

- programmatic composition;
- filtering;
- validation;
- future catalogue ingestion;
- compatibility checking;
- lower context usage;
- reliable downstream automation.

---

# 21. Return only what is needed

Large fixed responses are hostile to agent systems.

Where practical, list and retrieval capabilities should support ways to reduce unnecessary output.

Possible mechanisms include:

- field selection;
- projection;
- filters;
- date ranges;
- search constraints;
- pagination;
- sorting;
- limits.

For example:

```text
projects.search(
    query="hospital",
    fields=["id", "name", "status"],
    limit=20
)
```

is preferable to returning every known property for every matching project.

The exact mechanism can vary by MCP.

The principle is:

> **Do not send information to the caller that the caller has already said it does not need.**

Where the source system supports filtering or projection, push the operation toward the source instead of retrieving large datasets and discarding most of them later.

---

# 22. Pagination is mandatory for unbounded collections

Any capability that can return an unbounded collection must support bounded retrieval.

Do not expose:

```text
projects.list_all
documents.list_all
users.list_all
```

with unlimited results.

Use explicit parameters such as:

```text
limit
cursor
page_size
continuation_token
```

The default result size must be conservative.

The maximum result size must be enforced by the server.

Responses should indicate whether more results are available.

For example:

```json
{
  "items": [],
  "next_cursor": "abc123",
  "has_more": true
}
```

The server must not silently truncate a result without telling the caller.

---

# 23. Search is not list

Use different semantics for search and enumeration.

A search capability:

```text
documents.search
```

should accept criteria intended to find relevant records.

A list capability:

```text
projects.list
```

should enumerate a known collection with filters and pagination.

Do not overload one tool with incompatible behaviours.

Search responses should include stable identifiers so the caller can retrieve or act on the selected record later.

---

# 24. Explicit authority

No MCP capability should rely on unexplained ambient authority.

The server should know, for each request where applicable:

```text
organisation
principal
effective entitlements
target resource
requested capability
```

Capabilities should execute with the authority of the requesting principal where the underlying system permits this.

Where service credentials are unavoidable, the MCP must still enforce Answerable-side user and organisation authority before using them.

Never treat:

```text
the MCP can access it
```

as equivalent to:

```text
this user is allowed to access it
```

Authorisation must happen during prepare and again during commit for mutations.

Discovery or prior access must not be treated as proof of current authority.

---

# 25. No raw secrets in capability interfaces

Capabilities must not require callers to supply:

- API keys;
- passwords;
- OAuth client secrets;
- private keys;
- database credentials;
- vendor bearer tokens.

Credential management belongs behind the MCP boundary.

The caller should receive capability access, not credential access.

Similarly, sandboxed code should receive authorised capability handles rather than raw credentials.

---

# 26. Idempotency for state-changing operations

Prepared mutation commit provides the primary idempotency boundary for Answerable-managed mutations.

State-changing upstream operations must still be designed with their own retry semantics in mind.

Examples include:

```text
invoice.create
email.send
rfi.create
user.invite
deployment.start
```

Where the underlying API supports an idempotency key, propagate an Answerable mutation or idempotency identifier where practical.

If an upstream operation cannot be made safely idempotent, that limitation must be explicit in the capability contract and commit implementation.

---

# 27. Concurrency and version checks

Where lost updates are possible, mutating capabilities should capture and verify relevant state versions.

Possible mechanisms include:

```text
version
etag
updated_at
revision
```

The prepare stage should record the relevant precondition.

The commit stage should verify it.

For example:

```text
prepare projects.update
  current version = 17

commit
  expected version = 17
```

If the authoritative object has changed, fail with a structured stale or conflict result rather than silently overwriting newer state.

---

# 28. Structured errors

Errors must be machine-usable.

Do not return only:

```text
Something went wrong.
```

An error should contain, where relevant:

```json
{
  "code": "PERMISSION_DENIED",
  "message": "The current user cannot create RFIs in this project.",
  "retryable": false,
  "details": {
    "project_id": "123"
  }
}
```

Stable error categories should include at least the equivalents of:

```text
INVALID_INPUT
NOT_FOUND
PERMISSION_DENIED
CONFLICT
PREPARED_MUTATION_STALE
MUTATION_EXPIRED
MUTATION_ALREADY_COMMITTED
RATE_LIMITED
UPSTREAM_UNAVAILABLE
TIMEOUT
INTERNAL_ERROR
```

Add domain-specific errors where useful.

The caller should be able to distinguish:

```text
change the request
prepare again
ask the user
retry later
retrieve prior receipt
do not retry
```

without interpreting prose.

---

# 29. Retry semantics

Every capability should have predictable retry behaviour.

The implementation must distinguish between:

- validation failures;
- authorisation failures;
- stale prepared mutations;
- transient upstream failures;
- permanent upstream failures;
- timeouts;
- conflicts;
- rate limits.

Do not automatically retry state-changing upstream operations unless their retry behaviour is known to be safe.

Retries must be bounded.

Where an upstream service supplies retry guidance such as `Retry-After`, preserve or translate it where useful.

---

# 30. Timeouts and bounded work

Every capability must have a bounded execution expectation.

An MCP tool call must not quietly become an indefinite process.

Long-running work should normally:

```text
prepare start-operation mutation
        |
        v
commit
        |
        v
return operation identifier
        |
        v
durable process continues elsewhere
```

rather than holding the MCP request open indefinitely.

Where work must survive:

- process restart;
- worker failure;
- long waits;
- timers;
- external approval;
- delayed retry;

it belongs in a durable execution system such as Temporal.

MCP is the capability boundary.

It is not the durable workflow engine.

---

# 31. Long-running operations

If a committed capability starts asynchronous work, return a stable operation identifier.

For example:

```json
{
  "operation_id": "op_123",
  "status": "running"
}
```

Provide a way to inspect the operation:

```text
operations.get
```

and, where appropriate:

```text
operations.cancel
```

Cancellation is itself a mutation and should follow the applicable prepared mutation rules.

Do not force the caller to infer progress from unrelated system state.

---

# 32. Large-result handling

Do not return very large payloads directly into model context when there is a better representation.

For large results, consider:

- pagination;
- projection;
- summarisation;
- filtered retrieval;
- server-side aggregation;
- temporary result handles;
- document/resource references;
- sandbox processing.

For example:

```text
bad

search -> 50 MB result -> model
```

Prefer:

```text
search
  |
  v
bounded result or handle
  |
  v
filter / inspect / retrieve relevant parts
  |
  v
model
```

A capability should make the efficient path easy.

---

# 33. Programmatic calling

Capabilities should be safe to call from code as well as directly from a model.

Do not depend on conversational interpretation inside the MCP implementation.

Avoid contracts such as:

```text
instructions: "Describe what you want done in natural language."
```

when the operation can be represented structurally.

Prefer:

```json
{
  "project_id": "123",
  "status": "open",
  "created_before": "2026-09-01"
}
```

This makes capabilities easier to use from:

- `run_code`;
- Temporal activities;
- tests;
- Answerable applications;
- future capability infrastructure.

---

# 34. Programmatic mutation safety

Programmatic code may prepare mutations.

It should not automatically gain unlimited commit authority.

A strong default model is:

```text
run_code
   |
   +--> query
   +--> query
   +--> prepare mutation
   +--> prepare mutation
   |
   v
return proposed mutation set
```

The calling layer can then determine whether those mutations:

```text
may be agent-committed
require policy review
require human approval
```

This prevents one generated program from silently performing a large sequence of irreversible actions before the model or policy layer sees what happened.

Where `run_code` is explicitly allowed to commit low-risk mutations, that authority must be granted by policy rather than assumed.

---

# 35. Descriptions are operational documentation

Tool descriptions are part of the interface.

A good description should tell the caller:

- what the capability does;
- when to use it;
- important limitations;
- whether it changes state;
- whether it prepares a mutation;
- what important identifiers mean.

Avoid descriptions that merely repeat the tool name.

Bad:

```text
create_rfi

Creates an RFI.
```

Better:

```text
Prepare creation of an RFI in an existing project.

This capability changes authoritative project data when committed.

Use projects.search or projects.get first if the project identifier is
not already known. The caller must supply the RFI subject and project ID.
```

Descriptions should remain concise enough to use efficiently in model context.

---

# 36. Do not hide prerequisite state

If a capability requires another resource to exist, make that explicit.

For example:

```text
rfis.create
```

should clearly require:

```text
project_id
```

rather than trying to infer the target project from conversation history inside the MCP.

The caller can perform discovery first.

The MCP should not depend on hidden conversational state.

Capabilities should be deterministic with respect to their explicit inputs and authorised execution context where practical.

---

# 37. Stable identifiers

Return stable system identifiers wherever possible.

Do not require callers to use display names as identifiers if the underlying system has durable IDs.

Prefer:

```json
{
  "id": "project_123",
  "name": "King Street Redevelopment"
}
```

Then later calls should accept:

```text
project_id="project_123"
```

rather than:

```text
project_name="King Street Redevelopment"
```

Display names can change and may not be unique.

Prepared mutations must resolve and bind the stable identifier of every affected resource.

---

# 38. Preserve source identity

Where useful, returned resources should identify their authoritative source.

For example:

```json
{
  "id": "123",
  "source": "autodesk_construction_cloud",
  "external_id": "..."
}
```

Do not leak unnecessary implementation details, but preserve enough identity to support:

- audit;
- reconciliation;
- links back to source systems;
- duplicate detection;
- future federation across systems.

---

# 39. Time and dates

Use explicit machine-readable timestamps.

Prefer ISO 8601 timestamps with timezone information.

For example:

```text
2026-09-27T14:30:00+01:00
```

Do not return ambiguous values such as:

```text
27/09/26
tomorrow afternoon
last Monday
```

unless they are also accompanied by an explicit machine-readable value.

Mutation expiry times must always be explicit and machine-readable.

---

# 40. Units and numeric values

Never make units implicit where ambiguity is possible.

Prefer:

```json
{
  "area": {
    "value": 420.5,
    "unit": "m2"
  }
}
```

over:

```json
{
  "area": 420.5
}
```

The same applies to:

- currency;
- distance;
- mass;
- duration;
- temperature;
- percentages;
- coordinates.

Mutation previews should show units explicitly whenever the proposed change involves quantities.

---

# 41. Audit and execution metadata

Important calls should produce enough metadata to reconstruct what happened.

Where appropriate, record:

```text
capability identity
capability version
organisation
principal
execution ID
mutation ID
preparing actor
committing actor
approving actor if any
timestamp
input fingerprint
target resource
resource preconditions
preview fingerprint
outcome
upstream system
upstream request/correlation ID
duration
error classification
idempotency key
policy version
```

Not every field must be returned to the model.

Operational metadata and model-facing output are different concerns.

Sensitive input data must not be copied into logs merely for convenience.

---

# 42. Mutation lifecycle evidence

Important mutations should have a reconstructable lifecycle.

For example:

```text
requested
   |
   v
prepared
   |
   v
reviewed
   |
   +--> approved if required
   |
   v
committed
   |
   v
receipt
```

The evidence record should make it possible to determine:

```text
what was proposed
against what state
who requested it
who was authorised to commit it
whether separate approval was required
who approved it
what was actually committed
what the resulting state was
```

Prepared mutation state is operational state.

Canonical evidence remains owned by the system designated to own evidence.

---

# 43. Correlation IDs

Every capability execution should have an Answerable execution or correlation ID.

Propagate that identifier into upstream systems where possible.

A prepared mutation should also have a stable mutation ID that survives through commit and receipt.

This should make it possible to trace:

```text
OmniChat request
      |
      v
Toolbox / MCP call
      |
      v
prepare mutation
      |
      v
approval / commit
      |
      v
MCP server
      |
      v
vendor API
      |
      v
receipt / error
```

without relying on timestamps and guesswork.

---

# 44. Observability

Every production MCP should expose enough telemetry to answer:

```text
What is being called?
By whom?
For which organisation?
How long does it take?
What fails?
Why does it fail?
Which upstream dependency caused it?
How much data is returned?
How many mutations are prepared?
How many are committed?
How many become stale or expire?
```

At minimum, capture:

- request count;
- success/failure count;
- latency;
- upstream latency;
- error category;
- rate-limit events;
- timeout events;
- result size where useful;
- prepared mutation count;
- committed mutation count;
- stale mutation count;
- expired mutation count.

Do not include sensitive payloads in telemetry by default.

---

# 45. Rate and cost limits

A capability may have costs beyond compute.

Examples include:

- paid vendor API calls;
- AI inference;
- large database scans;
- export jobs;
- email sends;
- document processing.

Where relevant, enforce bounded usage.

Limits can exist at:

- user level;
- organisation level;
- capability level;
- upstream-service level.

Where a mutation has significant cost, the preview should expose that cost or expected cost where it can be known reliably.

The caller should receive a structured error when a limit prevents preparation or commit.

---

# 46. Avoid accidental N+1 behaviour

Capabilities likely to be used programmatically must be designed with composition cost in mind.

For example, avoid forcing:

```text
projects.list
      |
      +--> projects.get(project 1)
      +--> projects.get(project 2)
      +--> projects.get(project 3)
      ...
```

merely to retrieve basic fields that could have been returned by the list call.

At the same time, do not return enormous full objects by default.

Support sensible projections or summary representations.

The aim is to make efficient composition natural.

---

# 47. Query pushdown

When the underlying source supports:

- filtering;
- projection;
- joins or relationship traversal;
- aggregation;
- sorting;
- pagination;

use those capabilities where practical.

Prefer:

```text
source filters -> MCP returns relevant data
```

over:

```text
MCP downloads everything -> filters locally
```

unless there is a specific reason not to.

This principle applies whether the underlying system uses:

- GraphQL;
- SQL;
- REST;
- OData;
- vendor-specific query APIs.

---

# 48. Do not expose upstream protocols unnecessarily

The MCP boundary should normally expose Answerable capabilities rather than becoming a transparent tunnel.

Avoid tools such as:

```text
graphql(query)
sql(query)
http_request(method, url, body)
```

for ordinary client MCPs unless generic protocol access is itself the intended capability.

Prefer semantic capabilities such as:

```text
projects.search
documents.find
rfis.create
```

Generic query surfaces can be useful in controlled cases, but they require stronger policy, resource limits, and security controls.

Generic mutation surfaces require especially strong controls and should not bypass prepared mutation semantics.

---

# 49. Versioning

Prefer backwards-compatible evolution.

Safe changes include:

- adding optional fields;
- adding new enum values where clients can tolerate them;
- adding new output fields;
- adding new capabilities.

Potentially breaking changes include:

- renaming fields;
- removing fields;
- changing field meanings;
- changing identifier formats;
- making optional fields required;
- changing side-effect behaviour;
- changing mutation preview semantics;
- changing what a prepared mutation commits.

Breaking changes require an explicit migration path.

Do not silently repurpose an existing field or capability.

---

# 50. Deprecation

Deprecated capabilities must not disappear without warning.

A deprecation should specify:

```text
what is deprecated
replacement
reason
date deprecated
planned removal date
```

Where possible, the capability description or metadata should expose the deprecation.

The migration period should reflect actual client usage.

Prepared mutation tokens must not remain valid across an incompatible capability contract change.

---

# 51. Compatibility testing

Every MCP should have automated contract tests for its public capability surface.

Tests should cover:

- schema validity;
- required fields;
- representative success cases;
- permission failures;
- invalid input;
- upstream failures;
- pagination;
- retry behaviour;
- mutation preparation;
- mutation commit;
- stale mutation rejection;
- token expiry;
- idempotent commit;
- approval enforcement where relevant;
- output compatibility.

Treat capability contracts like API contracts.

A refactor that passes unit tests but breaks the public capability shape is still a breaking change.

---

# 52. Security boundaries

Assume MCP inputs are untrusted.

Validate:

- strings;
- identifiers;
- URLs;
- filenames;
- filters;
- query fragments;
- uploaded content;
- pagination parameters.

Do not allow caller input to become:

- arbitrary shell commands;
- unrestricted filesystem paths;
- arbitrary internal network requests;
- unsanitised SQL;
- unrestricted GraphQL;
- code executed outside an intentional sandbox.

Any capability that intentionally provides one of these powers needs its own explicit security design.

Prepared mutation tokens must be treated as security-sensitive capability material.

---

# 53. No ambient network access for generated code

If the MCP supports programmatic composition or code execution, generated code should not receive unrestricted network access.

It should receive explicit authorised capability handles.

Prefer:

```text
code
 |
 +--> projects.search()
 +--> rfis.list()
 +--> documents.read()
 +--> mutations.prepare(...)
```

over:

```text
code
 |
 +--> arbitrary internet
 +--> arbitrary internal network
 +--> raw credentials
```

This keeps authority visible and enforceable.

---

# 54. Confirmation and approval belong above the mutation primitive

The MCP should not fake confirmation by embedding prompts such as:

```text
Are you sure?
```

inside tool output.

The MCP's job is to produce a precise prepared mutation.

The calling layer decides how that mutation is reviewed.

Possible reviewers include:

```text
the agent itself
policy engine
human user
designated approver
separate application workflow
```

This separation keeps the mutation protocol reusable across interfaces.

---

# 55. High-impact actions

Capabilities with significant irreversible, external, financial, legal, or safety-relevant effects should normally require stronger commit policy.

Examples include:

```text
delete authoritative data
send external communications
make contractual submissions
approve financial transactions
publish information externally
change access permissions
```

The technical mutation protocol remains the same:

```text
prepare
review
commit
receipt
```

Only the commit authority changes.

---

# 56. Evidence is not logging

Operational logs help engineers understand what happened.

Evidence exists to support an authoritative record of important actions.

Where Answerable policy requires evidence, the MCP should provide the facts needed by the system that owns that evidence.

The MCP should not independently invent a parallel canonical evidence store.

Answerable Control owns canonical operational evidence.

---

# 57. Events

Where an integration naturally produces events, model them as events rather than forcing consumers to poll forever.

Examples:

```text
document.created
rfi.updated
project.archived
submission.received
```

Events should include:

```text
event identity
event type
organisation
source
resource identity
timestamp
relevant version
```

Where possible, consumers should be able to process duplicate event delivery safely.

Durable reaction to events belongs in the appropriate workflow or application layer.

---

# 58. Source failures must remain visible

Do not convert every upstream failure into a generic successful response.

Bad:

```json
{
  "items": []
}
```

when the real situation is:

```text
SharePoint API unavailable
```

An empty authoritative result and a failed query are different facts.

Preserve that distinction.

The same applies during mutation preparation. If current state cannot be read reliably, do not fabricate a preview.

---

# 59. Eventual consistency must be explicit

If an operation can succeed before the result becomes visible elsewhere, document that behaviour.

For example:

```text
document uploaded successfully
search index may take several minutes to include it
```

Do not force callers to infer eventual consistency from intermittent results.

Where practical, the mutation receipt should return:

- resulting resource ID;
- operation state;
- expected consistency behaviour.

---

# 60. MCP implementation is not the product model

An MCP server can contain vendor-specific code.

Its public capability surface should still be designed from the customer's problem outward.

The internal structure may be:

```text
Graph API
Autodesk API
SQL
SOAP
GraphQL
REST
vendor SDK
```

The public MCP should expose:

```text
documents.search
projects.get
rfis.create
```

where those are the stable capabilities customers and agents actually need.

---

# 61. Design for future catalogue ingestion

A future Answerable capability catalogue should be able to inspect an MCP and derive, with little or no bespoke integration:

```text
what capabilities exist
what each capability does
what inputs it accepts
what outputs it returns
whether it changes state
whether it supports prepared mutation
whether agent commit is allowed
whether human approval may be required
whether it is idempotent
what limits apply
whether it is deprecated
who may use it
```

This is a design test, not a requirement to build the catalogue now.

If a human has to read the MCP source code to understand its public contract, the MCP is underspecified.

---

# 62. Design for future query infrastructure

Do not require every read capability to behave like an opaque function call.

Where useful, preserve enough schema and query semantics to support future:

- projection;
- filtering;
- aggregation;
- relationship traversal;
- catalogue-generated query interfaces.

This does not mean every MCP must expose GraphQL.

It means MCPs should not unnecessarily destroy useful structure that exists in the underlying system.

---

# 63. Design for future mutation infrastructure

Do not make every MCP invent its own side-effect confirmation mechanism.

Prepared mutation semantics should be consistent enough that a future Answerable capability layer can mediate:

```text
prepare
preview
policy
approval
commit
receipt
```

across many MCPs.

A future Toolbox should be able to treat:

```text
SharePoint mutation
Autodesk mutation
CRM mutation
Answerable-written mutation
```

through the same high-level lifecycle even when the underlying APIs differ completely.

---

# 64. Design for future orchestration

Any capability that might participate in a larger process should expose enough information for deterministic orchestration.

For a state-changing operation, return stable facts such as:

```text
mutation ID
resource ID
operation ID
result state
version
timestamp
receipt
```

rather than only:

```text
Done.
```

This allows future workflows to continue without scraping prose or repeating work.

---

# 65. Prepared mutations are not distributed transactions

The prepare/commit model does not imply transactional isolation across external systems.

Do not claim atomicity merely because the API uses the word `commit`.

The model is:

```text
prepare intended transition
        |
        v
bind it to known state
        |
        v
commit if preconditions still hold
```

not:

```text
lock every external system
        |
        v
wait for model or human
        |
        v
atomically commit everything
```

Use optimistic concurrency by default.

Where multi-system atomicity is impossible, state the semantics clearly and use durable orchestration where necessary.

---

# 66. The client should not need to know the implementation

The same conceptual capability should look similar regardless of whether it is implemented through:

```text
MCP
REST
GraphQL
SQL
vendor SDK
Answerable code
```

Implementation details may appear where they are genuinely useful, but they should not define the capability model.

This is what makes later consolidation into Answerable Toolbox possible.

---

# 67. Recommended read capability checklist

Before shipping a read capability, verify:

- Does its name describe a durable business capability?
- Are its inputs explicitly typed?
- Are its outputs structured?
- Are identifiers stable?
- Is collection output bounded?
- Does it support filtering or projection where useful?
- Is authority checked at execution?
- Does it avoid exposing secrets?
- Are retries safe and defined?
- Are errors structured?
- Are timeouts bounded?
- Can another program call it without conversational context?
- Is important operational metadata traceable?
- Can it evolve without unnecessarily breaking callers?
- Could a future capability catalogue understand it automatically?

---

# 68. Recommended mutation capability checklist

Before shipping a mutation, verify:

- Is the capability clearly marked as state-changing?
- Can it prepare without causing the business side effect?
- Does preparation resolve the exact affected resources?
- Does the preview show meaningful before/after change where possible?
- Does the preview describe known effects and warnings?
- Is the mutation bound to a stable mutation ID?
- Is the commit token scoped to the exact mutation?
- Does the token expire?
- Are relevant resource versions or preconditions captured?
- Does commit recheck authority?
- Does commit recheck state?
- Does commit recheck policy?
- Is stale state rejected rather than silently overwritten?
- Is commit idempotent?
- Can a retry return the existing receipt?
- Is required human approval bound to the specific mutation?
- Is the resulting receipt structured?
- Can the mutation lifecycle be audited?
- Can a future Toolbox mediate it without bespoke logic?

If several answers are no, redesign the mutation before adding more callers.

---

# 69. Decision summary

> **Answerable MCP design rule**  
> Build each MCP as a clean provider of stable, typed, bounded, authorised capabilities that can be composed by systems the MCP does not know about.

For state-changing capabilities:

> **Prepare first. Commit second.**  
> Every meaningful mutation should be able to describe the exact change it intends to make before the side effect occurs. The prepared mutation must be bound to the caller, capability, inputs, affected resources, relevant state, policy context, and expiry. Commit must recheck authority and preconditions and must be safe to retry.

Do not optimise only for today's OmniChat interaction.

Design for a future in which many client-specific MCPs are:

```text
discovered
searched
queried
composed
prepared
reviewed
approved
committed
governed
observed
orchestrated
```

through shared Answerable infrastructure.

The future infrastructure does not need to exist yet.

The MCP contracts should make it possible.
