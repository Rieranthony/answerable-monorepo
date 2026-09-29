# Answerable Toolbox

## High-level design

# 1. Purpose

Answerable Toolbox gives AI controlled access to the capabilities that an organisation allows it to use.

A capability can come from an MCP server, an API, a queryable data source, an event source, or Answerable code. Its implementation can use MCP, OpenAPI/HTTP, GraphQL, SQL, RPC, or another protocol.

The user sees one Toolbox. The implementation can use many systems, protocols, and runtimes behind it.

> **Core idea**  
> The Toolbox is the customer-facing product. The Capability Plane is the internal architecture that makes the Toolbox work.

The Toolbox owns the stable Answerable view of what the organisation can do. The implementation behind a capability can change without changing its identity in the Toolbox.

For state-changing capabilities, Toolbox also provides the common mutation boundary:

> **Prepare first. Commit second.**  
> A mutation should describe the exact change it intends to make before that change occurs.

---

# 2. What the customer sees

Inside OmniChat, the AI connects to one first-party MCP server: Toolbox MCP.

Toolbox MCP does not expose every capability schema directly to the model. It exposes a small set of meta-tools that let the model find and use the right capability when it needs it.

| Tool | Purpose |
|---|---|
| search | Find relevant capabilities in the authorised Toolbox. |
| describe | Get the schema, semantics, and instructions for a selected capability. |
| execute | Use a selected capability. Read operations can return a result immediately. Mutating operations can return a prepared mutation. |
| commit | Commit a specific prepared mutation when the caller has authority to do so. |
| run_code | Run short sandboxed code that can use authorised capabilities programmatically. |

This pattern keeps a large capability catalogue out of the model context.

It also supports efficient programmatic work. For example, `run_code` can query many projects, combine capability calls, filter and transform intermediate results, and return only the useful output to the model.

Where a capability supports projection, filtering, aggregation, or other query pushdown, Toolbox should avoid retrieving information that the sandbox will immediately discard.

For mutations, `execute` does not necessarily mean “perform the side effect now.” It can mean “evaluate this request and prepare the exact state change that would occur.”

---

# 3. High-level architecture

```text
                        OMNICHAT
                           |
                           | MCP
                           v
              +-------------------------+
              |       TOOLBOX MCP       |
              |                         |
              | search                  |
              | describe                |
              | execute                 |
              | commit                  |
              | run_code                |
              +------------+------------+
                           |
                           v
              ANSWERABLE TOOLBOX CORE
              +-------------------------+
              | Capability catalogue    |
              |                         |
              | Capability type/schema  |
              | model                   |
              |                         |
              | Mutation preparation    |
              | and commit boundary     |
              |                         |
              | Executor-derived        |
              | adapters                |
              |                         |
              | code sandbox            |
              |                         |
              | query / execute         |
              +------------+------------+
                           |
              +------------+-------------+
              |            |             |
              v            v             v
           OpenAPI      GraphQL         MCP
           adapter       adapter       adapter
                                          |
                                          v
                              +---------------------+
                              |      TOOLHIVE       |
                              |                     |
                              | Gateway             |
                              | Runtime             |
                              | Registry            |
                              | Isolation           |
                              +----------+----------+
                                         |
                           +-------------+-------------+
                           |             |             |
                           v             v             v
                          MCP           MCP           MCP
                       workload      workload        remote
```

The customer-facing capability model does not depend on the protocol or runtime used by the underlying system.

A GraphQL service, for example, can be an external implementation behind a capability. Separately, Answerable may later use GraphQL or another query language as part of its own internal query surface. Those are different architectural roles.

The same separation applies to mutation handling. An underlying system can use REST, GraphQL mutations, RPC, MCP, or another mechanism. Toolbox still presents one common prepared-mutation lifecycle above it.

---

# 4. The main design rule

> **One capability membrane**  
> All capability access crosses an Answerable-owned Toolbox boundary.

Direct model calls, `run_code`, Temporal activities, and Answerable applications do not bypass Toolbox policy, authorisation, limits, observability, mutation controls, or evidence rules.

```text
LLM direct call --------+
run_code sandbox -------+
Temporal Activity ------+----> TOOLBOX ----> implementation
Answerable app ---------+
```

At the architecture level, Toolbox mediates different forms of interaction:

```text
                       TOOLBOX
                          |
          +---------------+---------------+
          |               |               |
          v               v               v
      DISCOVER           QUERY          MUTATE
                                          |
                                          v
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

`Toolbox.execute()` is the initial common interface for invoking capabilities.

The architecture does not require every interaction to have identical semantics.

The important invariant is:

> Capability use cannot bypass the Toolbox authority boundary.

For mutations, that means callers must not bypass:

- preparation;
- preview;
- commit policy;
- authority checks;
- concurrency checks;
- evidence rules.

This gives Answerable one place to apply:

- authorisation;
- policy;
- rate and cost limits;
- audit;
- observability;
- evidence rules;
- safety controls;
- organisation and user boundaries;
- mutation preparation and commit controls.

---

# 5. Capability interaction model

Toolbox does not require every capability to have the same interaction model.

At the architecture level, capabilities can support several forms of interaction.

| Interaction | Meaning | Possible implementation |
|---|---|---|
| Discover | Find what capabilities, types, fields, operations, or events exist. | Toolbox catalogue, schemas, GraphQL introspection |
| Query | Retrieve or analyse information without intentionally changing authoritative state. | GraphQL, SQL, REST, MCP |
| Mutate | Propose and apply a state change or external effect. | MCP, RPC, REST, GraphQL mutation |
| Subscribe | Receive information when something changes. | Events, webhooks, streams |
| Compose | Combine multiple capability interactions into one piece of work. | `run_code`, predefined composites, Temporal |

These are semantic categories, not protocol choices.

The same underlying protocol can support more than one category. GraphQL, for example, can support both querying and mutation. MCP can expose both read-only and state-changing tools.

The initial Toolbox MCP surface can remain small even as the internal capability model grows.

---

# 6. Prepared Mutations

State-changing capabilities follow a deliberate two-stage model:

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

Preparation determines:

- the exact capability being invoked;
- the exact inputs;
- the affected resources;
- the relevant current state;
- the expected changes;
- known effects and warnings;
- the authority and policy context;
- any concurrency preconditions.

It returns an immutable mutation intent or equivalent commit handle.

No business side effect occurs during preparation.

Commit then applies that exact prepared mutation if:

- the caller still has authority;
- the mutation has not expired;
- required approval is present;
- relevant state has not changed incompatibly;
- applicable policy still allows the operation.

The commit is idempotent and returns a structured receipt.

The high-level invariant is:

> **No surprising mutations.**  
> A state-changing capability must be able to describe the intended change before that change is applied.

---

# 7. Mutation review and approval

Preparation and approval are different concepts.

A prepared mutation can be reviewed by:

```text
agent
policy engine
human user
designated approver
application workflow
```

The same mutation protocol can support different commit policies.

Typical categories are:

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

The technical lifecycle stays the same:

```text
prepare
   |
   v
preview
   |
   +--> agent review
   |
   +--> policy decision
   |
   +--> human approval if required
   |
   v
commit
```

Approval must be bound to the specific prepared mutation rather than to a vague conversational instruction.

---

# 8. Responsibilities

| System | Primary responsibility |
|---|---|
| Answerable Toolbox | Own the customer-facing capability model, catalogue, discovery, schemas, common authority boundary, and prepared mutation lifecycle. |
| Executor-derived machinery | Adapt non-MCP systems, search large catalogues, support lazy schema discovery, and provide programmatic capability calling. |
| ToolHive | Operate MCP capabilities. Run, proxy, isolate, aggregate, and observe MCP workloads. |
| Answerable ID | Own human identity, organisation membership, entitlements, and token issuance. |
| Answerable Control | Own products, purchases, desired capability state, deployment intent, policy context, and canonical operational evidence. |
| Temporal | Make long-running and multi-step business processes durable. |

No infrastructure substrate defines the customer-facing Toolbox model.

Toolbox owns that model.

---

# 9. Three types of composition

The platform needs three forms of composition.

They solve different problems and must not become competing workflow systems.

| Mechanism | Use it for | Typical lifetime |
|---|---|---|
| `run_code` | Dynamic, agent-generated work with loops, branching, filtering, transformation, parallel capability calls, and mutation preparation. | Milliseconds to minutes |
| ToolHive composite | Predefined deterministic composition of MCP capabilities. | Short request lifetime |
| Temporal workflow | Durable processes with retries, timers, waiting, external events, approval, recovery, and long-running coordination. | Seconds to months |

The boundaries are intentional.

`run_code` is for ephemeral computation.

ToolHive composites are for predefined short-lived MCP composition.

Temporal owns durable process state.

`run_code` may prepare mutations. It does not automatically gain unlimited authority to commit them.

---

# 10. Organisation and user boundaries

Each organisation has one logical Toolbox.

The physical deployment can be shared or isolated. The security view is always organisation-specific and user-specific.

```text
User
 |
 v
Answerable ID
 |
 | organisation + principal + entitlements
 v
Toolbox MCP
 |
 v
authorised view of the organisation Toolbox
 |
 +--> search only returns allowed capabilities
 |
 +--> describe only reveals allowed capabilities
 |
 +--> query checks authority
 |
 +--> prepare checks authority
 |
 +--> commit checks authority again
 |
 +--> run_code can use only allowed capabilities
```

A denied capability should normally be absent from `search` and `describe` results.

The system must still check authority whenever the capability is used.

Discovery is not an authorisation decision.

Preparation is also not final authorisation.

Authority and policy are checked again at commit time because:

- permissions can change;
- organisation membership can change;
- policy can change;
- resource state can change;
- approval requirements can change.

---

# 11. Why ToolHive is below Toolbox

ToolHive is an MCP infrastructure substrate.

It knows how to run and proxy MCP servers.

Toolbox knows what a capability means to Answerable and how users and agents discover and use it.

This separation lets Answerable use ToolHive without making the ToolHive data model the product model.

A native MCP capability can go directly through ToolHive.

A non-MCP capability first passes through an adapter.

The user does not need to know which path is used.

```text
                    TOOLBOX
                       |
           +-----------+-----------+
           |                       |
           v                       v
      MCP capability        non-MCP capability
           |                       |
           v                       v
       ToolHive                  adapter
           |                       |
           v                       v
      MCP workload          external system
```

Prepared mutation semantics sit above both paths.

ToolHive can operate the underlying MCP workload without owning the Answerable mutation model.

---

# 12. Query and mutation are different concerns

A query asks the system for information.

A mutation asks the system to change authoritative state or cause an external effect.

Those two interactions can share the same Toolbox authority boundary without being forced into the same internal representation.

For example:

```text
QUERY
 |
 +--> select fields
 +--> filter
 +--> traverse relationships
 +--> aggregate
 +--> sort
 +--> limit
 |
 v
small relevant result
```

A mutation instead follows:

```text
MUTATION REQUEST
      |
      v
   PREPARE
      |
      +--> resolve targets
      +--> read current state
      +--> calculate changes
      +--> calculate effects
      +--> establish preconditions
      |
      v
   PREVIEW
      |
      v
review / policy / approval
      |
      v
    COMMIT
      |
      +--> re-authorise
      +--> re-check policy
      +--> re-check state
      +--> perform side effect
      |
      v
   RECEIPT
```

Toolbox should preserve this distinction even if both interactions initially enter through the same MCP `execute` tool.

---

# 13. Mutation intent

A prepared mutation represents one immutable intended state transition.

Conceptually, it binds:

```text
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
mutation identity
```

The implementation can use:

- a signed token;
- an opaque server-side handle;
- another equivalent mechanism.

The important rule is semantic:

> A commit handle authorises exactly the prepared mutation, not arbitrary later use of the capability.

For example, a token prepared for:

```text
delete document A
```

must not be usable to delete:

```text
document B
```

or to change the arguments of the operation after review.

---

# 14. Stale prepared mutations

A mutation preview is valid only against the state for which it was prepared.

For example:

```text
prepare
  budget: £100,000 -> £120,000
  resource version: 17
```

If another actor changes the resource before commit:

```text
resource version: 18
```

the original mutation must not silently apply.

Commit should reject it as stale and require preparation again.

```text
prepare at version 17
       |
       v
review
       |
       v
commit
       |
       v
still version 17?
   |            |
  yes           no
   |            |
   v            v
apply        reject
             and reprepare
```

Use optimistic concurrency by default.

Toolbox should not hold external locks while a model or human reviews a preview.

---

# 15. Mutation receipts

A successful commit returns a structured receipt.

A receipt should contain enough stable facts to support downstream automation and evidence.

For example:

```text
mutation identity
capability identity
affected resource
before version
after version
commit status
commit timestamp
resulting operation ID where relevant
```

The receipt is distinct from logs.

It is the machine-readable result of the state transition.

A caller should not need to infer success from prose such as:

```text
Done.
```

---

# 16. Query pushdown

Toolbox should prefer doing filtering, projection, aggregation, and pagination as close as possible to the system that owns the data.

For example:

```text
less desirable

source
 |
 | large response
 v
sandbox
 |
 | filter + select
 v
small response
 |
 v
LLM
```

Prefer:

```text
source
 |
 | filter + select at source
 v
small response
 |
 v
sandbox if composition is needed
 |
 v
LLM
```

This reduces:

- network transfer;
- sandbox work;
- latency;
- memory use;
- model context;
- unnecessary disclosure of information.

GraphQL is one possible mechanism for query pushdown.

SQL is another.

Existing REST APIs can also provide filtering and projection.

Toolbox should use the strongest supported query semantics of the underlying system without exposing those implementation details unnecessarily to the customer.

---

# 17. Why programmatic capability calling matters

A model can often complete a large task more efficiently by writing a short program that uses many capabilities inside a sandbox.

Intermediate results stay inside the sandbox.

The model receives the final useful result instead of every intermediate response.

```text
User request
 |
 v
run_code
 |
 +--> projects.list()
 |
 +--> for each project: rfis.list()
 |
 +--> filter old RFIs
 |
 +--> sort by urgency
 |
 v
small final result returned to the model
```

This can substantially reduce model context use.

However, programmatic filtering should not become a substitute for source-side querying.

Where possible:

```text
ask source for precise information
            |
            v
compose / transform in sandbox
            |
            v
return small useful result
            |
            v
           LLM
```

is preferable to:

```text
retrieve large result
        |
        v
discard most of it in sandbox
        |
        v
return small result
```

This feature should be part of the Toolbox platform.

It should not depend on one model provider.

The sandbox gets capability handles, not raw secrets or unrestricted network access.

---

# 18. Programmatic mutation safety

Programmatic capability calling makes mutation controls more important.

Without a mutation boundary:

```text
run_code
  |
  +--> update(...)
  +--> delete(...)
  +--> send(...)
  +--> create(...)
```

could perform many side effects before the model or policy layer sees what happened.

With prepared mutations:

```text
run_code
  |
  +--> prepare update(...)
  +--> prepare update(...)
  +--> prepare send(...)
  +--> prepare create(...)
            |
            v
       mutation set
            |
            v
        review / policy
```

This allows programmatic work to discover and prepare many changes efficiently without automatically granting authority to apply all of them.

Where useful, Toolbox can support batch mutation previews.

A batch preview must not imply transactional atomicity unless the underlying implementation actually provides it.

---

# 19. Capability schemas and types

Toolbox needs a stable way to describe what a capability accepts and returns.

The source system can use different type systems:

```text
OpenAPI schemas --------+
GraphQL types ----------+
MCP schemas ------------+
Protobuf descriptors ---+
SQL metadata -----------+
Answerable code types --+
                        |
                        v
              Toolbox capability model
```

The Toolbox representation should preserve enough structure for:

- discovery;
- validation;
- authorisation;
- model use;
- code generation;
- programmatic calling;
- observability;
- compatibility checks;
- mutation preview generation.

The Toolbox type model should not require every source system to adopt the same protocol.

Where practical, standard schema formats should be reused instead of inventing Answerable-specific type syntax.

---

# 20. Events and subscriptions

Not every interaction begins with a caller asking for something.

Some capabilities are event sources.

Examples include:

```text
document.created
project.updated
invoice.approved
workflow.completed
user.permission.revoked
```

The Toolbox capability model should leave room for subscriptions and events even if they are not part of the first Toolbox MCP surface.

Events can trigger:

- Answerable applications;
- Temporal workflows;
- notifications;
- cache invalidation;
- follow-up agent work;
- operational processes.

Toolbox should describe what events exist and who is authorised to subscribe to them.

Temporal remains responsible for durable processes triggered by those events.

---

# 21. Long-running mutations

Some committed mutations begin work rather than completing it synchronously.

For example:

```text
prepare export.start
        |
        v
preview
        |
        v
commit
        |
        v
operation_id
        |
        v
durable work continues
```

The commit receipt should identify the resulting long-running operation.

Toolbox should not hold an MCP request open indefinitely when the work should instead be represented as a durable operation or workflow.

Temporal remains responsible for long-running and failure-resilient process execution.

---

# 22. Target product model

The customer should think in terms of capabilities and connected systems, not runtimes and protocols.

```text
ANSWERABLE TOOLBOX

Documents
  - Search SharePoint
  - Read document
  - Upload document
  - Delete document
  - Watch for new documents

Projects
  - Find project
  - List RFIs
  - Create RFI
  - Update RFI
  - Watch project changes

CRM
  - Find organisation
  - Find contact
  - Create task

Answerable
  - Search company knowledge
  - Ask training tutor
```

Some capabilities can come from MCP.

Some can come from OpenAPI or GraphQL.

Some can operate over SQL-accessible data.

Some can be event sources.

Some can be Answerable-written code.

The Toolbox hides that implementation detail.

For state-changing capabilities, the customer-facing semantics remain consistent even when the underlying implementation differs:

```text
prepare
review
commit
receipt
```

---

# 23. Design principles

- The Toolbox is the product abstraction. ToolHive and Executor are implementation substrates.
- A capability has one stable Answerable identity even if its implementation changes.
- All capability use crosses the Toolbox authority boundary.
- Discovery, query, mutation, subscription, and composition are different semantic interactions even where they share infrastructure.
- Authorisation is checked during discovery where appropriate and again whenever a capability is used.
- Discovery is never treated as proof of authority.
- **No surprising mutations.** A state-changing capability must be able to describe the intended change before it is applied.
- **Prepare first. Commit second.**
- Mutation preparation is separate from approval.
- Commit authority can belong to an agent, policy decision, human, or another authorised actor.
- A commit applies one exact prepared mutation, not generic capability permission.
- Commit rechecks authority, policy, and relevant resource state.
- Commit must be safe to retry.
- Stale prepared mutations are rejected rather than silently applied.
- The sandbox has no ambient authority. It receives only the capabilities that the caller can use.
- `run_code` may prepare mutations without automatically gaining unrestricted commit authority.
- Query work should be pushed toward the source where practical so unnecessary information is not retrieved or placed into model context.
- Toolbox can use different protocols for different capability types.
- No single protocol is part of the customer-facing abstraction.
- Temporal owns durable processes. `run_code` does not become a durable workflow engine.
- ToolHive owns MCP operation. Toolbox does not reimplement Kubernetes or MCP proxy infrastructure without a clear need.
- Answerable Control owns desired state and canonical evidence. Infrastructure systems report facts back to Control.
- Implementation details must not leak into the customer-facing model.

---

# 24. Initial delivery path

1. Run ToolHive and Executor separately for a proof of concept.
2. Put an Answerable-owned Toolbox API in front of both systems.
3. Implement `search`, `describe`, `execute`, `commit`, and `run_code` as the first Toolbox MCP surface.
4. Define the first stable Answerable capability identity and schema model.
5. Define the common prepared-mutation envelope and receipt shape.
6. Route MCP-backed capabilities through ToolHive.
7. Use Executor components for non-MCP adapters and programmatic capability calling.
8. Connect Answerable ID for user and organisation authority.
9. Preserve the distinction between query and mutation internally.
10. Require state-changing capability adapters to support prepare and commit semantics where practical.
11. Call the Toolbox capability boundary from Temporal activities for durable processes.
12. Test query pushdown against suitable OpenAPI and GraphQL sources.
13. Test prepared mutations against at least two substantially different underlying systems.
14. Investigate a richer Toolbox query layer separately before committing the architecture to GraphQL, SQL, or another query language.
15. Replace full Executor services with selected embedded packages only when the boundary is proven.

---

# 25. Decision summary

> **Target architecture**  
> Toolbox owns the capability catalogue, schema model, common authority boundary, and mutation lifecycle. It mediates discovery, querying, mutation, subscription, and composition without requiring them to use the same protocol. State-changing capabilities are prepared before they are committed, so the exact intended change can be reviewed and governed before the side effect occurs. Executor-derived machinery makes capabilities discoverable, adaptable, and programmatically composable. ToolHive operates MCP capabilities. Temporal makes processes over capabilities durable. Answerable ID determines authority. Answerable Control determines what should exist and owns canonical operational evidence.

The customer sees one Toolbox.

Behind it, Answerable can choose the best interaction model and protocol for each class of capability without changing the product abstraction.

The central mutation rule is:

> **Prepare first. Commit second.**

A mutation should never require the caller to trust that an opaque action will do what was intended. Toolbox should make the intended state change visible before it becomes real.

# Reference implementations

These sources describe the current open-source projects that informed this design.

They are implementation references, not architecture authorities.

[UsefulSoftwareCo/executor — vision](https://github.com/UsefulSoftwareCo/executor/blob/main/vision.md)

[Stacklok ToolHive — architecture overview](https://github.com/stacklok/toolhive/blob/main/docs/arch/00-overview.md)

[Stacklok ToolHive — repository](https://github.com/stacklok/toolhive)
