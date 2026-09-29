# Prepared mutations, approvals and query surfaces: research notes

Date: 2026-09-28. Status: COMPLETE. Every claim is tagged VERIFIED (fetched URL, or an official page's search snippet where the fetch was blocked) or INFERRED. Quotes are under 15 words and at most one per source.

## Summary

- Prepare-then-commit is well trodden. Kubernetes `dryRun`, AIP-163 `validate_only`, Terraform saved plans, Open Banking payment consents, PayPal/Adyen authorise-then-capture and AP2 mandates all separate "compute and bind what will happen" from "make it happen". The strongest analogues for Answerable are Open Banking (consent object with immutable payload, single use, exact-match check, expiry) and Terraform (plan embeds the observed state serial and apply refuses when it moved).
- The elements to mirror are concrete: `validate_only` semantics (same authorisation and validation as the real call, omit unknowable fields), AIP-154 etags with `ABORTED` on mismatch, IETF `Idempotency-Key` semantics (replay stored result; 422 on fingerprint mismatch; 409 while in flight), `google.longrunning.Operation` / MCP tasks for long-running commits, and `google.rpc` `ErrorInfo{reason, domain, metadata}` plus the three-way retry rule (UNAVAILABLE = retry the call, ABORTED = redo the read-modify-write, FAILED_PRECONDITION = fix state first).
- Every agent framework converges on one shape: proposal (tool name + arguments) -> durable pause (serialised run state, checkpoint, workflow, or a run that ends with an approval request) -> decision bound to the proposal's id -> resume. Claude Code adds the one thing the others lack: a server-declared flag (`_meta["anthropic/requiresUserInteraction"]`) that no client automation can bypass, and a deny > ask > allow policy enforced outside the model.
- MCP elicitation is not an approval mechanism: it is an optional client capability, the answer is unauthenticated, the schema is flat and nothing binds it to a tool call. No official text forbids using it for approvals, and none makes it safe; the spec only says servers must not request sensitive information through it and clients should confirm sensitive operations.
- Approval binding: use an opaque, single-use commit token backed by a server record (intent id, principal, capability version, input fingerprint over RFC 8785 canonical JSON, target versions, policy class, expiry, approval state). Signed credentials (JWS, SD-JWT as in AP2, RFC 9396 `authorization_details`, Biscuit attenuation) are only needed when prepare, approve and commit cross trust domains; previews are sensitive (Terraform warns plan files are), so they must never travel inside a token.
- Version signals exist in every mainstream target: HTTP `If-Match`/412, Graph `@odata.etag` (Planner requires it), driveItem `eTag`/`cTag`, SharePoint version labels, Salesforce `If-Match`/`If-Unmodified-Since`/412, Kubernetes `resourceVersion`/409, Autodesk immutable versions with a tip, Procore `updated_at`. Model "relevant resource versions" as a list of typed version signals, not one etag.
- GraphQL as an agent interface: measured NL2GraphQL accuracy is 31-48% across eight LLMs on real schemas; every vendor that ships GraphQL over MCP defaults to predefined, validated operations with mutations off, and adds `search`/`introspect`/`validate`/`execute` only for exploration; Shopify and GitHub ship fixed tools. A `describe` + `query` surface earns its place for read-heavy, cross-entity questions where fixed read tools would explode, and only as a read-only, validated, depth- and cost-limited projection of Answerable's own schema, never the upstream protocol.
- OpenAPI projection tools (FastMCP, Stainless, Gram, openapi-mcp-generator) all map one operation to one tool, moved away from GET-as-resource, and solve tool explosion with curation, meta-tools or code execution; agent annotations are vendor `x-` objects per operation (`x-openai-isConsequential`, `x-speakeasy-mcp.scopes`, `x-gram`, `x-mcp`). Answerable's `x-kind`/`x-scopes` fit that convention and should map onto them.
- Errors: adopt one envelope (`code` UPPER_SNAKE_CASE + `domain` + `status` + `message` + `details` + `retry` hint + `request_id`), delivered as MCP `structuredContent` with `isError: true`, and as RFC 9457 problem details over HTTP, with codes for the prepared-mutation state machine (INTENT_STALE, INTENT_EXPIRED, IDEMPOTENCY_KEY_MISMATCH, APPROVAL_REQUIRED, COMMIT_IN_PROGRESS, ...).

## 1. Two-phase / preview-then-apply prior art

### Kubernetes dry run and server-side apply
- VERIFIED (https://kubernetes.io/docs/reference/using-api/api-concepts/): `?dryRun=All` on POST/PUT/PATCH; the server runs full validation and admission and returns the object "as if" persisted, including generated `uid`/`resourceVersion`, without storing it. Dry-run requests are still authorised exactly like real requests. Admission webhooks must declare `sideEffects: None|NoneOnDryRun` to be called on dry-run (webhooks with side effects must skip them).
- VERIFIED (https://kubernetes.io/docs/reference/using-api/server-side-apply/): apply requires a `fieldManager` identity; `managedFields` records per-manager field ownership; a conflict is "a special status error" (HTTP 409) raised when an Apply changes a field another manager claims; resolution: `force=true` (kubectl `--force-conflicts`) takes ownership, or drop the field from your manifest, or share ownership by setting the same value. Ownership moves to whoever last changed the value.
- Lesson to mirror: preview = same authorisation + same validation path as commit, returns the would-be result, and downstream effects (webhooks) are explicitly classified as side-effect-free or not.

### Terraform plan/apply with saved plans
- VERIFIED (https://developer.hashicorp.com/terraform/cli/commands/plan): `-out=FILE` saves "your full configuration, all of the values associated with planned changes, and all of the plan options including the input variables". Docs warn sensitive data is saved in cleartext in the plan file; treat plan files as sensitive artefacts. `-refresh=false` gives a faster but possibly "incomplete or incorrect plan".
- VERIFIED (https://developer.hashicorp.com/terraform/cli/commands/apply): applying a saved plan performs the planned operations without prompting for confirmation; `terraform show` inspects a saved plan before applying; no extra planning options may be given with a saved plan.
- VERIFIED (https://raw.githubusercontent.com/hashicorp/terraform/main/internal/backend/local/backend_local.go): two guard diagnostics when applying a saved plan. "Saved plan is stale" / "The given plan file can no longer be applied because the state was changed by another operation after the plan was created." fires when `priorStateFile.Serial != currentStateMeta.Serial`; "Saved plan does not match the given state" / "...created from a different state lineage." fires when the lineage differs. The plan therefore carries the prior state's serial and lineage, and apply compares them before doing anything.
- Lesson to mirror: a prepared intent must embed enough of the observed state to be checked at commit, is sensitive (contains data), and commit takes no new options.

### IETF Idempotency-Key header
- VERIFIED (https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header, draft -07, 2025-10-15, expired 2026-04-18 but still the reference): header `Idempotency-Key` (Structured Field String, UUID recommended). Key "MUST be unique and MUST NOT be reused with another request with a different request payload". Same key + different payload -> 422 Unprocessable Content with a problem document; retry arriving while the original is still processing -> 409 Conflict; missing key when required -> 400. Optional "idempotency fingerprint" (checksum / field match / request signature) validates the payload. On a duplicate, respond "with the result of the previously completed operation, success or an error". Expiry policy is the resource's choice and should be published.

### Stripe idempotency
- VERIFIED (https://docs.stripe.com/api/idempotent_requests): `Idempotency-Key` header, up to 255 chars, V4 UUID suggested; Stripe stores the first status code and body "regardless of whether it succeeds or fails" and replays it (including 500s); keys pruned after >= 24 h; parameters compared to the original and the request errors if they differ; results saved only once endpoint execution begins (validation failures and concurrent conflicts are not saved, so they are retryable); POST only.
- Follow-up: the mismatch error is `type: idempotency_error` (HTTP 400) per Stripe error docs (to verify in section 7 fetch).

### Google AIPs
- VERIFIED AIP-163 (https://google.aip.dev/163): `bool validate_only` on the request; the API "may provide an option to validate, but not actually execute, a request", returning the same status/headers/body it would have returned; it "must perform permission checks and any other validation" of a live request, and "must fail if it determines that the actual request would fail"; fields that cannot be computed without executing (auto-generated IDs) are omitted; mandatory on all mutation methods of declarative-friendly resources (AIP-128).
- VERIFIED AIP-151 (https://google.aip.dev/151): long-running methods return `google.longrunning.Operation` (`name`, `metadata` Any, `done`, `error` google.rpc.Status | `response` Any) and carry the `google.longrunning.operation_info` annotation with `response_type` and `metadata_type`; the API must implement the `Operations` service (Get/List/Cancel/Wait/Delete); metadata carries progress and partial failures; operations "may" expire, rule of thumb 30 days.
- VERIFIED AIP-155 (https://google.aip.dev/155): optional `string request_id` with `(google.api.field_info).format = UUID4`; "Providing a request ID must guarantee idempotency"; on a duplicate the server "should return the response for the previously successful request" (or the current resource state when history cannot be kept); any reasonable retention window. Does not define behaviour for same id + different body (the IETF draft does: 422).
- VERIFIED AIP-154 (https://google.aip.dev/154): `string etag` on resources, server-provided, RFC 7232 quoted format, weak etags prefixed `W/`; a matching etag "must permit the request"; a non-matching etag -> `ABORTED` error; no etag -> request should be permitted; declarative-friendly resources must have an etag.

### Open Banking UK (PSD2) payment initiation
- VERIFIED (https://openbankinguk.github.io/read-write-api-site3/v3.1.10/resources-and-data-models/pisp/domestic-payment-consents.html): POST /domestic-payment-consents returns a `ConsentId`; status lifecycle AwaitingAuthorisation -> Authorised -> Consumed (or Rejected); consent is single use ("Consumed" after one domestic-payment is created from it); Initiation elements "must not be changed" after consent (the later payment must match them exactly); response carries CutOffDateTime / ExpectedExecutionDateTime; `x-idempotency-key` header is mandatory on POSTs.
- VERIFIED (https://openbankinguk.github.io/read-write-api-site3/v3.1.10/resources-and-data-models/pisp/domestic-payments.html): POST /domestic-payments carries the `ConsentId`; the Initiation and Risk sections must match the consent's, otherwise 400 `UK.OBIE.Resource.ConsentMismatch`; the consent must be `Authorised`, otherwise `UK.OBIE.Resource.InvalidConsentStatus`; the payment then has its own `DomesticPaymentId` and status (Pending, Rejected, AcceptedSettlementInProcess, AcceptedSettlementCompleted, AcceptedWithoutPosting, AcceptedCreditSettlementCompleted).
- VERIFIED (https://openbankinguk.github.io/read-write-api-site3/v3.1.10/profiles/read-write-data-api-profile.html): error envelope `OBErrorResponse{Code, Id, Message, Errors[]{ErrorCode, Message, Path, Url}}` with namespaced codes such as `UK.OBIE.Field.Invalid`, `UK.OBIE.Header.Missing`, `UK.OBIE.Resource.NotFound`, `UK.OBIE.Rules.AfterCutOffDateTime`, `UK.OBIE.Signature.*`; `x-idempotency-key` at most 40 characters, honoured for 24 hours per TPP, payload must not change under the same key, duplicates answered 201 with the current resource state.
- Lesson: the strongest analogue for HUMAN-APPROVAL-REQUIRED: a consent object is created with the exact payload, a human authorises that object, and execution must reference the consent id and repeat the identical payload; consents are single use and expire.

### PayPal / Adyen authorise then capture
- VERIFIED (https://developer.paypal.com/docs/checkout/standard/customize/authorization/): `intent=authorize` places a hold; guaranteed honour period 3 days, authorisation valid 29 days; capture later by authorization id; reauthorise after 3 days ("generates a new authorization ID and restarts the 3-day honor period"); void cancels before capture.
- VERIFIED (https://docs.adyen.com/online-payments/capture/): capture references the authorisation `pspReference` (POST /payments/{paymentPspReference}/captures); automatic, delayed-automatic or manual capture; capture amount must equal or be below the authorised amount; a single partial capture auto-cancels the remainder; multiple partial captures need enabling; per-scheme maximum window; capture is asynchronous (response status `received`, then `CAPTURE` / `CAPTURE_FAILED` webhooks carrying `originalReference`); cancel reverses an authorisation, refund reverses a capture.
- Lesson: authorise (prepare) and capture (commit) are separate resources; capture is bounded by the authorisation (amount ceiling, validity window), keyed by the authorisation's reference, and its completion is asynchronous with a receipt event.

## 2. Agent frameworks: human-in-the-loop for tool calls

### OpenAI Agents SDK (JS and Python)
- VERIFIED (https://openai.github.io/openai-agents-js/guides/human-in-the-loop/): `tool({ needsApproval })` (boolean or function); a run pauses with `result.interruptions` containing tool-approval items; `state.approve(interruption)` / `state.reject(interruption)` with `alwaysApprove` / `alwaysReject` options; `result.state` serialises via `toString()` and `RunState.fromString()` so the paused run can be stored and resumed later; a rejection is fed back to the model.
- VERIFIED (https://openai.github.io/openai-agents-python/human_in_the_loop/): `needs_approval=True` or an async callable on `function_tool`; `RunResult.interruptions` holds `ToolApprovalItem` entries (with `agent.name`, `tool_name`, `arguments`); `state = result.to_state()`; `state.approve(interruption, always_approve=False)`; `state.reject(interruption, rejection_message=None)`; `state.to_json()` / `to_string()` and `RunState.from_json(agent, dict)` / `from_string`; resume with `Runner.run(agent, state)`; resume must target the original top-level agent.
- Shape: proposal (tool call + arguments) -> serialisable paused state -> decision bound to the interruption item -> resume.

### LangGraph
- VERIFIED (https://docs.langchain.com/oss/python/langgraph/interrupts): `interrupt(value)` pauses and surfaces any JSON-serialisable payload in `result["__interrupt__"]`; `Command(resume=...)` resumes and its value becomes the return of `interrupt()`; requires a checkpointer and the same `thread_id`; the node restarts "from the beginning of the node" on resume so code before `interrupt()` re-runs (side effects must be idempotent or placed after); multiple interrupts resume by id: `Command(resume={interrupt_id: value})`; interrupts survive process restarts through the checkpointer. Documented patterns: approve/reject, review-and-edit, tool-call approval inside the tool function.
- Lesson: the durable pause is the checkpoint; the decision is keyed by interrupt id; re-execution semantics force idempotent prepare.

### Claude Agent SDK / Claude Code
- VERIFIED (https://code.claude.com/docs/en/agent-sdk/permissions): evaluation order is Hooks -> deny rules -> ask rules -> permission mode -> allow rules -> `canUseTool` callback. A `PreToolUse` hook may deny outright; a hook "allow" does not skip deny/ask rules. Deny rules block "even in `bypassPermissions` mode". Modes: `default`, `dontAsk` (denies anything that would prompt; `canUseTool` never called), `acceptEdits`, `bypassPermissions`, `plan`, `auto` (classifier). MCP tools whose server sets `_meta["anthropic/requiresUserInteraction"]` "always fall through to the callback, even when an allow rule matches" (denied in `dontAsk`); same for `AskUserQuestion` and connector tools an organisation set to `ask`. Auto-approved tools never reach `canUseTool`. TypeScript warning code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` when the callback would be shadowed.
- VERIFIED (https://code.claude.com/docs/en/permissions): rule types `allow`, `ask`, `deny`; "Rules are evaluated in order: deny, then ask, then allow"; specifier syntax `Bash(npm run *)`, `Edit(docs/**)`, `Read(./.env)`, `WebFetch(domain:example.com)`, `mcp__server__tool`, `mcp__server__*`; an allow rule cannot carve an exception out of a deny rule; permission rules "are enforced by Claude Code, not by the model"; `PreToolUse` hooks run before the prompt and a hook exit code 2 blocks before rules are evaluated; hook decisions never bypass deny/ask rules.
- VERIFIED (https://code.claude.com/docs/en/mcp, section "Require approval for a specific tool"): an MCP server marks a tool by "setting `_meta["anthropic/requiresUserInteraction"]` to `true` in the tool's `tools/list` response entry" (must be JSON `true`); Claude Code then prompts "on every call, even in `acceptEdits`, `auto`, and `bypassPermissions`" modes with no "don't ask again", allow rules do not skip it, `dontAsk` denies it, and in non-interactive mode an `allow` from `--permission-prompt-tool` "is converted to a deny" because "The prompt has to reach a person"; Remote Control withholds one-tap approval for such tools. Intended "for tools whose permission prompt is itself the point, such as a consent or access-grant step". Requires Claude Code v2.1.199+.
- VERIFIED (https://code.claude.com/docs/en/agent-sdk/user-input): `canUseTool(toolName, input, { signal, suggestions })` returns `{ behavior: "allow", updatedInput, updatedPermissions? }` or `{ behavior: "deny", message }` (Python `PermissionResultAllow(updated_input=...)` / `PermissionResultDeny(message=...)`); the callback "can stay pending indefinitely"; for waits longer than the process can live, a `PreToolUse` hook may return the `defer` decision so the session persists and resumes later; approvals can modify the input before execution and Claude is not told.
- VERIFIED (https://www.anthropic.com/engineering/writing-tools-for-agents): prefer a few workflow-level tools over many granular ones (`schedule_event` instead of `list_users` + `list_events` + `create_event`), namespace by service and resource, offer `response_format: concise | detailed`, paginate/truncate with instructions, and write errors that state "specific and actionable improvements"; too many or overlapping tools distract agents.
- Lesson: a three-valued policy (deny / ask / allow) with deny-first precedence, a server-declared "requires user interaction" flag that no client-side automation can bypass, and enforcement outside the model. This maps directly onto HUMAN-APPROVAL-REQUIRED (server-declared, cannot be auto-approved), CONTROLLED (ask), AGENT-COMMITTABLE (allow). Answerable should set this `_meta` key on its `commit` tools for HUMAN-APPROVAL-REQUIRED capabilities (harmless for other clients, which ignore unknown `_meta`).

### Vercel AI SDK
- VERIFIED (https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling, page shows AI SDK 7.x): tool-level `needsApproval` is now deprecated in favour of a run-level `toolApproval` option on `generateText` / `streamText` / `ToolLoopAgent` (function or per-tool map); parts `tool-approval-request` and `tool-approval-response` carry an `approvalId` and `approved: true|false`; UI resumes via `addToolApprovalResponse` in `useChat`.
- VERIFIED (https://vercel.com/blog/ai-sdk-6, 2025-12-22): AI SDK 6 introduced `needsApproval` (boolean, or a function of the input); the tool part enters an `'approval-requested'` state and the UI answers with `addToolApprovalResponse` (approval id + boolean). So: introduced in 6, generalised to `toolApproval` in 7.

### Inngest
- VERIFIED (https://www.inngest.com/docs/reference/functions/step-wait-for-event): `step.waitForEvent(id, { event, timeout, match | if })` returns the `EventPayload` or `null` on timeout; the function is paused durably with no compute while waiting; the documented approval pattern matches on a correlation id (`match: "data.invoiceId"`) with a deadline such as `"7d"`.

### Temporal
- VERIFIED (https://docs.temporal.io/encyclopedia/workflow-message-passing): Signals are "asynchronous write requests" (fire and forget), Queries are read-only and never block, Updates are "synchronous, tracked write requests" with validation and a result.
- VERIFIED (https://docs.temporal.io/develop/typescript/message-passing): `defineSignal('approve')` + `setHandler(approve, ...)` sets `approvedForRelease = true`; the workflow blocks with `await wf.condition(() => approvedForRelease)`; Update handlers take a synchronous `validator` that rejects bad input before it is recorded in history.
- VERIFIED (https://typescript.temporal.io/api/namespaces/workflow#condition): `condition(fn, timeout)` returns `Promise<boolean>`, resolving `false` when the timeout expires instead of throwing, so an approval wait with a deadline is one line.
- Lesson: the durable wait is a workflow primitive; validation of the decision happens before it is persisted; the decision is addressed to a specific workflow (run id) = the proposal id.

### Google ADK
- VERIFIED (https://adk.dev/tools-custom/confirmation/): `FunctionTool(fn, require_confirmation=True)` or a callable evaluated on the arguments (e.g. amount threshold); inside a tool, `tool_context.request_confirmation(hint=..., payload=...)`; the agent pauses and emits an `adk_request_confirmation` function call; the client answers with a `FunctionResponse` whose `id` matches the function call and whose `response` is `{ "confirmed": true|false, "payload": {...} }`; with the Resume feature the response must carry the matching `invocation_id`; `DatabaseSessionService` and `VertexAiSessionService` are "not supported by this feature"; TypeScript needs manual handling via `toolContext?.requestConfirmation()` / `toolConfirmation?.confirmed`.
- Lesson: confirmation is a function call/response pair keyed by id; a `payload` lets the human return edited values, not only yes/no.

### Microsoft Agent Framework
- VERIFIED (https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval, page dated 2026-07-01): .NET wraps a function in `ApprovalRequiredAIFunction`; a run that needs approval "will complete with a response that indicates what input is required" instead of a final answer; the caller finds `ToolApprovalRequestContent` items (with `ToolCall` -> `FunctionCallContent` name and arguments), calls `requestContent.CreateResponse(true|false)` and sends it back as a user `ChatMessage` on the same `AgentSession`. Python: `@tool(approval_mode="always_require")`, `result.user_input_requests[i].function_call`, `to_function_approval_response(True|False)`; without a session the caller must resend the original query + the assistant approval-request message + the approval response. Go: `tool.ApprovalRequiredFunc`. The "Harness Agent" adds middleware for queued requests, standing "always approve" rules, `auto_approval_rules`, and "approval-response binding" (`DisableApprovalResponseBinding` opt-out) so a response is tied to its request.
- Lesson: the approval request is a first-class content item bound to a specific function call; the response is a content item that must be matched to that request (binding) on the same thread.

### MCP specification
- VERIFIED (https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation): `elicitation/create` with `message` + `requestedSchema` (flat object of string/number/boolean/enum only); result `action: accept | decline | cancel` with `content` only on accept. Trust and safety: "Servers MUST NOT use elicitation to request sensitive information"; clients SHOULD show which server is asking, allow review/modification, allow decline at any time, rate limit. Elicitation is marked as newly introduced and may evolve. There is NO statement that elicitation is unsuitable for approving destructive actions; the spec is silent on that. The design (flat schema, three actions, no binding to a tool call id) means an elicitation "confirm" is not bound to an intent unless the server binds it (server-side record keyed by the pending intent). INFERRED: elicitation is usable as an in-band confirmation channel for AGENT-COMMITTABLE/CONTROLLED classes only when the client supports it (capability `elicitation` must be declared); it must never be the only approval path for HUMAN-APPROVAL-REQUIRED because clients may not implement it and the server cannot verify who answered.
- VERIFIED (https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts, `ToolAnnotations`): `readOnlyHint` (default false), `destructiveHint` (default true, meaningful only when not read-only), `idempotentHint` (default false), `openWorldHint` (default true), `title`; all are hints and "Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers." `CallToolResult.isError`: "If not set, this is assumed to be false".
- VERIFIED (https://modelcontextprotocol.io/specification/2025-11-25/changelog): 2025-11-25 adds experimental "tasks" (SEP-1686) "to enable tracking durable requests with polling and deferred result retrieval" (a native long-running-operation primitive), URL-mode elicitation (SEP-1036), richer enum elicitation (SEP-1330), defaults in elicitation schemas, incremental scope consent via `WWW-Authenticate` (SEP-835), OAuth Client ID Metadata Documents (SEP-991), icons, tool-name guidance (SEP-986), and clarifies that "input validation errors should be returned as Tool Execution Errors rather than Protocol Errors to enable model self-correction" (SEP-1303).
- VERIFIED (https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks, experimental): a `tools/call` may carry `params.task: { ttl }`; the receiver immediately returns `CreateTaskResult` with a `task` object (`taskId` receiver-generated, `status`, `statusMessage`, `createdAt`, `lastUpdatedAt`, `ttl` (ms, may be overridden, `null` = unlimited), `pollInterval`); statuses `working` -> `input_required` | `completed` | `failed` | `cancelled` (terminal states never transition); `tasks/get` polls, `tasks/result` blocks until terminal and returns exactly what the underlying call would have returned, `tasks/cancel`, `tasks/list`; optional `notifications/tasks/status`; a tool result with `isError: true` puts the task in `failed`; capability `tasks.requests.tools.call` and per-tool `execution.taskSupport: "required" | "optional" | "forbidden"`; all related messages carry `_meta["io.modelcontextprotocol/related-task"]`; optional `_meta["io.modelcontextprotocol/model-immediate-response"]` text for the model. Security: when an authorisation context exists receivers "MUST bind tasks to said context" and reject get/result/cancel from other contexts; otherwise task ids must be cryptographically random with short TTLs; enforce concurrency and TTL limits; log lifecycle events.
- Lesson: the MCP-native LRO shape to mirror for `operation_id` (id + status enum + timestamps + ttl + poll hint + result retrieval that reproduces the underlying result), and its context-binding rule is the same rule a commit token needs.
- VERIFIED (https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices): covers confused deputy (per-client consent before third-party authorisation, consent UI must name the client, scopes and redirect URI, single-use short-lived `state`), token passthrough ("MUST NOT accept any tokens that were not explicitly issued for the MCP server"), SSRF, session hijacking ("MUST NOT use sessions for authentication", bind session ids to user ids), local server compromise, OAuth URL validation, scope minimisation (baseline scopes, incremental elevation via `WWW-Authenticate scope=...`). It contains no guidance on elicitation as an approval channel nor on destructive-action confirmation; those live only in the tools page (clients SHOULD confirm sensitive operations) and the elicitation page (no sensitive information). Conclusion for the standard: no official text forbids using elicitation for approvals, but nothing makes it reliable either (optional client capability, unauthenticated answer, flat schema, no binding to a tool call).
- VERIFIED (https://modelcontextprotocol.io/specification/2025-06-18/server/tools): tool result = `content[]` + optional `structuredContent` + `isError`; tool execution errors (API failures, invalid input, business logic) are reported with `isError: true` in the result, protocol errors (unknown tool, invalid arguments) as JSON-RPC errors; if `outputSchema` is given, servers MUST conform and clients SHOULD validate. Security: "there SHOULD always be a human in the loop with the ability to deny tool invocations"; clients SHOULD "Prompt for user confirmation on sensitive operations" and show tool inputs before calling; clients MUST treat tool annotations as untrusted unless the server is trusted.

## 3. Approval binding and tokens

### RFC 8785 JSON Canonicalization Scheme
- VERIFIED (https://www.rfc-editor.org/rfc/rfc8785.html, Informational): deterministic JSON serialisation for hashing/signing: properties sorted by UTF-16 code units, numbers serialised per ECMAScript (IEEE 754 double), no whitespace, fixed string escaping; input must be I-JSON (RFC 7493), so 64-bit integers or high-precision decimals must be carried as strings. Designed so JWS can sign JSON that is still exchanged in its original form.
- Use: compute `input_fingerprint = sha256(JCS(input))` and `intent_digest = sha256(JCS(intent))`; never hash raw JSON text.

### RFC 9396 OAuth 2.0 Rich Authorization Requests
- VERIFIED (https://www.rfc-editor.org/rfc/rfc9396.html): `authorization_details` is a JSON array of typed objects (`type` required; common fields `locations`, `actions`, `datatypes`, `identifier`, `privileges`); the canonical example is `type: "payment_initiation"` with `instructedAmount`, `creditorName`, `creditorAccount`; the AS shows the details to the user for consent and "MUST also return the authorization_details as granted" in the token response (also visible via introspection); malformed or unknown details -> `invalid_authorization_details`.
- Use: the OAuth-native way to bind a token to one exact transaction. Relevant if Answerable ID ever issues per-intent tokens; for now an internal server-side approval record is simpler.

### AP2 mandates (Google Agent Payments Protocol, spec v0.2)
- VERIFIED (https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/specification.md and .../checkout_mandate.md): v0.2 defines two mandates, the Checkout Mandate and the Payment Mandate, both carried as SD-JWTs. The merchant signs a `checkout_jwt` describing the exact order; the closed Checkout Mandate (`vct: mandate.checkout.1`) carries `checkout_hash` = base64url hash of that JWT plus `iat`/`exp`, and is signed by the user through a Trusted Surface ("direct" mode) or by the agent's key within user-approved constraints ("autonomous" mode, open mandate `mandate.checkout.open.1` with allowed merchants and line-item constraints and the agent key as a `cnf` claim, `exp` set as small as the task allows). The Payment Mandate is bound to the checkout by that hash, and verifiers check the presented checkout's hash equals `checkout_hash`. Earlier public material described Intent/Cart/Payment mandates; the current spec text does not use those names.
- Lesson: bind an approval to a hash of the exact artefact shown to the approver, carry an expiry, and name the key that may act (holder binding). This is the same shape as OB "Initiation must not change" and Terraform's serial check, expressed as signed credentials because the parties are in different trust domains.

### Macaroons / Biscuit
- VERIFIED (https://doc.biscuitsec.org/ and https://doc.biscuitsec.org/getting-started/introduction): a Biscuit is "signed with public key cryptography (like JWT), so that any service knowing the public key can verify the token"; "from a Biscuit token, you can create a new one with more restrictions, without communicating with the service that created the token" by appending blocks with checks; authorisation rules are Datalog and "can be provided by the authorizer's side, but also by the token"; offline attenuation is "like Macaroons". Macaroons (Birgisson et al., NDSS 2014) chain HMACs over caveats and support third-party caveats; INFERRED from general knowledge, not fetched.
- Use: attenuation is the right mental model for "approval narrows what the commit may do", but a signed bearer token is only needed when commit happens on a different trust domain than prepare. Inside one Answerable service, an opaque id + server record gives the same binding without key management or the risk of leaking preview data in a token.

## 4. Optimistic concurrency signals in external systems

- HTTP (VERIFIED https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match): `If-Match` compares strong validators; on failure the origin server "MUST NOT perform the requested method" and responds 412 (Precondition Failed), unless it can tell the change already happened (2xx allowed); `If-Unmodified-Since` is the date-based variant, also 412.
- Google APIs (VERIFIED AIP-154): `etag` on the resource, `ABORTED` on mismatch.
- Kubernetes (VERIFIED https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions): `metadata.resourceVersion` "is an opaque string" that must not be compared numerically; "If the resourceVersion field is specified and does not match the current resourceVersion of the object, the request will be rejected with a 409 Conflict response"; 410 Gone when a watch/list version is too old; server-side apply adds per-field managers and 409 on ownership conflicts.
- Microsoft Graph Planner (VERIFIED https://learn.microsoft.com/en-us/graph/api/resources/planner-overview): "Planner versions all resources using etags" returned as `@odata.etag`; `PATCH` and `DELETE` "require the last etag known by the client to be specified with a `If-Match` header"; mismatches produce 409/412 and clients must re-read and merge; etags of different resources are not comparable.
- Microsoft Graph driveItem / SharePoint files (VERIFIED https://learn.microsoft.com/en-us/graph/api/resources/driveitem): `eTag` is the "eTag for the entire item (metadata + content)", `cTag` "An eTag for the content of the item" (unchanged by metadata-only edits, not returned for folders); items also expose a `versions` collection (`driveItemVersion`), and `@microsoft.graph.conflictBehavior` (`fail` | `replace` | `rename`) on create.
- SharePoint list items via Graph (VERIFIED https://learn.microsoft.com/en-us/graph/api/listitemversion-get): `GET /sites/{site-id}/lists/{list-id}/items/{item-id}/versions/{version-id}` returns `id` such as `"1.0"`, `lastModifiedDateTime`, `lastModifiedBy`, `fields`.
- Salesforce REST (search snippet of the official page https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest_conditional_requests.htm; direct fetch blocked 403): `If-Match` (ETag list) and `If-Unmodified-Since` on sObject Rows; mismatch -> 412 Precondition Failed and the request is not processed; invalid header values on PATCH/POST -> 400; supported on sObject Rows, sObject Describe, Describe Global and Invocable Actions. Every record also carries `SystemModstamp` / `LastModifiedDate` (INFERRED from general Salesforce knowledge, not fetched).
- Autodesk Construction Cloud / APS Data Management (VERIFIED https://aps.autodesk.com/llms.txt; the reference pages themselves are JS-rendered and came back empty): items are file objects, versions are file iterations and "tip" is the latest version; webhooks `dm.version.added`, `dm.item.updated` etc. signal change. INFERRED from the official overview snippet (https://aps.autodesk.com/developer/overview/data-management-api): a version is an immutable snapshot, so "resource version" for ACC = the tip version id (`...?version=N`).
- Procore (search snippets of https://developers.procore.com/reference/rest/rfis and https://procore.github.io/documentation/webhooks): resources carry `updated_at` (used as a sync cursor via `filters[updated_at]`), submittals carry `revision`; webhooks deliver `resource_name`, `resource_id`, `event_type`, `timestamp`; no ETag/If-Match documented. INFERRED: for Procore, "resource version" = `updated_at` (plus `revision` where present), so staleness is detected by comparing the timestamp captured at prepare.
- Summary: every mainstream target exposes at least one of {opaque etag, monotonic version label, immutable version id, last-modified timestamp}. "Relevant resource versions" in a prepared intent is realistic if it is modelled as a list of `{ resource, version_kind: etag|version|timestamp, value }` rather than a single etag.

## 5. GraphQL as an agent interface

### Apollo MCP Server
- VERIFIED (https://www.apollographql.com/docs/apollo-mcp-server): "makes GraphQL API operations available to AI clients as MCP tools"; four ways to define tools: operation files (`.graphql`), persisted query manifests, GraphOS operation collections, and schema introspection ("Dynamic operation discovery for flexible AI exploration"); the server sends "a structured GraphQL HTTP request to your API endpoint using the configured headers and authentication" so access policy stays in the GraphQL layer.
- VERIFIED (https://www.apollographql.com/docs/apollo-mcp-server/define-tools): each predefined operation becomes one tool: name = operation name, description from `overrides.descriptions` config, then operation description comments, then `#` comments, then schema-generated text; input schema from the operation variables (nullability via `anyOf`, defaults). The server "stores its document separately from the model-facing tool metadata", so the model never supplies the query text. Introspection tools: `introspect` (type by name), `search` (terms -> relevant types, with `leaf_depth` and `index_memory_bytes`), `validate` (checks an operation without executing it), `execute` (ad hoc operation, subject to operation-type restrictions); `minify` shrinks schema output (`T=type`, `I=input`, `E=enum`, `s=String`, `i=Int`). Warning in the docs: `execute` "isn't pinned to a previously reviewed document".
- VERIFIED (https://www.apollographql.com/docs/apollo-mcp-server/config-file): `operations.source: local | collection | manifest | uplink | infer`; `introspection.execute.enabled`, `introspect.enabled` (+ `minify`), `search.enabled` (+ `index_memory_bytes`, `leaf_depth`), `validate.enabled`; `overrides.mutation_mode: "none"` (queries only, ad hoc mutations rejected) | `"explicit"` (predefined queries and mutations only) | `"all"` (any, including ad hoc); `overrides.disable_type_description`, `disable_schema_description`, `enable_output_schema`; `forward_headers` (warns on `Authorization`/`Cookie`), static `headers` with `${env.VAR}`; with `transport.auth`, auth is validated before tool invocation.
- VERIFIED (https://www.apollographql.com/blog/building-efficient-ai-agents-with-graphql-and-apollo-mcp-server): argues REST returns whole objects while GraphQL selection sets return only needed fields; names the "Goldilocks Problem" of tool count (too few = no granularity, too many = token budget and confusion); operation collections can pre-fill variables so the model decides less. No measured token or accuracy numbers.

### Grafbase
- VERIFIED (https://grafbase.com/docs/gateway/mcp): `[mcp] enabled = false` (default), `path = "/mcp"`, `execute_mutations = false` (default), `transport = "http-streaming" | "sse"`; "All HTTP headers are forwarded from the MCP request, as if you were querying the `/graphql` endpoint" so the same auth/authorisation applies; OAuth 2.1 with RFC 9728 protected-resource metadata; "schema contracts" choose which subset of the API agents can see.
- VERIFIED (https://grafbase.com/blog/managing-mcp-context-graphql): the problem is that "the more capabilities you want to provide to the agent, the bigger its context needs to be"; the three-tool design (`search`, `introspect`, `execute`) builds a Tantivy index over fields, scores by relevance with exponential decay by depth from the root types, and returns a filtered schema "until we reach a hard-coded context size limit"; `execute` returns error-related schema fragments so the model can correct itself. No token or accuracy numbers.

### WunderGraph Cosmo
- VERIFIED (https://cosmo-docs.wundergraph.com/router/mcp): the router "loads GraphQL operations from a specified directory", validates them against the schema and exposes them as tools; design principle "instead of allowing AI models to execute arbitrary GraphQL operations, it exposes a predefined set of validated and approved operations"; `get_schema` and `execute_graphql` are optional built-in tools; example excludes mutations and masks sensitive fields.

### Hasura PromptQL
- VERIFIED (https://promptql.io/blog/how-promptql-achieves-100-accuracy-for-ai-on-enterprise-data): the model writes a query plan that is executed programmatically outside the context window, with AI primitives (classify, summarise, extract) applied in isolation and intermediate results stored as artefacts; the argument is that accuracy declines as more data points enter the context and that tool calling "cannot separate plan creation from plan execution"; the "100%" framing is admitted to be provocative. The "~2x accuracy / ~4x repeatability" figures appear in search snippets of Hasura marketing pages, not in this post: vendor claims, no independent test.
- Lesson: PromptQL is not "the model writes GraphQL"; it is "the model writes a plan, the engine executes it". It supports the cofounder's instinct (compositional power) but through a constrained, validated plan language, not raw query text.

### Shopify Storefront MCP
- VERIFIED (https://shopify.dev/docs/apps/build/storefront-mcp): fixed tools (`search_catalog`, `get_product_details`, `get_cart`, `update_cart`, `search_shop_policies_and_faqs`) served at `https://{shop}/api/mcp`; the model does not write GraphQL; checkout is handed off through a checkout URL rather than executed by the agent; now superseded by the Universal Commerce Protocol at `https://{shop}/api/ucp/mcp` with separate Catalog, Cart and Checkout MCPs. Lesson: a GraphQL-first company shipped fixed tools, not a query surface, for a consumer-facing agent, and kept payment out of the agent.

### GitHub MCP server
- VERIFIED (https://raw.githubusercontent.com/github/github-mcp-server/main/README.md): mostly REST-backed tools with GraphQL used for some toolsets (projects `list_project_items`, discussions: cursor pagination and node ids); 100+ tools across ~24 toolsets; `--toolsets` / `GITHUB_TOOLSETS` allow-list (`default` = context, repos, issues, pull_requests, users; `all`), `--read-only` skips write tools "even if explicitly requested via --tools". Lesson: even GitHub, which has a full public GraphQL API, exposes fixed tools grouped into toolsets to control tool count, rather than a raw GraphQL surface.

### Evidence on LLM accuracy with GraphQL composition
- Search snippets of the ACM DL abstract (https://dl.acm.org/doi/10.1145/3814574.3816745, "Synthetic Data Generation for Schema-Aware Query Interfaces: Benchmarking NL2GraphQL Systems"; direct fetch blocked 403): 1,845 manually validated instances across 20 real-world schemas; eight contemporary LLMs reach 31-48% accuracy; failure modes are structural invalidity, schema misalignment and incorrect argument binding. Treat as VERIFIED-by-abstract.
- No rigorous head-to-head "GraphQL query composition vs fixed tools" study was found; the vendor posts (Apollo, Grafbase, Stainless, PromptQL) argue from context size, not measured accuracy.
- VERIFIED (https://research.ibm.com/publications/robust-evaluation-of-llm-generated-graphql-queries-for-web-services, ICWS 2025): RGEval is "the first benchmarking pipeline designed to systematically assess the quality of LLM-generated GraphQL queries"; LLMs produce suboptimal queries because of limited schema awareness; equivalent queries differ syntactically, which makes even evaluation hard. No accuracy percentages in the abstract.
- VERIFIED (https://proceedings.mlr.press/v267/patil25a.html, BFCL, ICML 2025): "while state-of-the-art LLMs excel at singleturn calls, memory, dynamic decision-making, and long-horizon reasoning remain open challenges"; multi-turn accuracy is all-or-nothing per trajectory.
- INFERRED synthesis: the measured weakness is exactly the skill a `query` tool demands (compose a correct operation against a large schema). Fixed, pre-validated operations remove that failure mode; a query surface should therefore be typed, validated before execution (`validate`), searchable in small chunks, and read-only.

### Risks and mitigations
- VERIFIED (https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html): depth limiting and amount limiting ("By default these can both be unlimited which may lead to a DoS"), pagination caps, query cost analysis (only if needed), query and resolver timeouts, rate limiting, resolver-level authorisation on edges and nodes (IDOR), disabling introspection in production (attackers "can still guess fields by brute forcing"), input validation and parameterised queries for injection, batching/alias limits.

## 6. OpenAPI to capability projection

### FastMCP `from_openapi`
- VERIFIED (https://gofastmcp.com/integrations/openapi): since v2.8.0 "all routes become Tools" by default (`RouteMap(mcp_type=MCPType.TOOL)`); before that GET routes became Resources / ResourceTemplates, changed "for client compatibility"; `RouteMap(methods, pattern, tags, mcp_type: TOOL | RESOURCE | RESOURCE_TEMPLATE | EXCLUDE, mcp_tags)`, first match wins; names from `operationId` up to the first `__`, slugified and truncated to 56 chars, overridable with `mcp_names`; `route_map_fn` and `mcp_component_fn` hooks customise type, tags, descriptions; parameters and body are flattened into one input schema; `allOf` flattened.
- Lesson: the industry moved away from "GET -> resource" because clients handle tools far better than resources; keep reads as tools with `readOnlyHint`.

### openapi-mcp-generator
- VERIFIED (https://raw.githubusercontent.com/harsha-iiiv/openapi-mcp-generator/main/README.md): one tool per operation named from `operationId` (hash suffix beyond 64 chars); parameters + body -> Zod schema; auth from env (`API_KEY_<SCHEME>`, `BEARER_TOKEN_<SCHEME>`, `OAUTH_CLIENT_ID/SECRET_<SCHEME>`); vendor extension `x-mcp` (boolean) at root/path/operation to include or exclude, `--default-include` flips the default; stdio/SSE/StreamableHTTP/Workers transports.

### Speakeasy (Gram and SDK generator)
- VERIFIED (https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi): naive generation yields tool proliferation, poor names, oversized schemas, and "LLMs hallucinate with poor OpenAPI documentation"; recommended: curate toolsets, rewrite descriptions for agents ("what data to expect in the response, when to use this endpoint vs alternatives"); the `x-speakeasy-mcp` extension can "override tool names and descriptions", "group related tools with scopes" and "control which tools are available in different contexts"; scopes are declared per operation, e.g. `x-speakeasy-mcp: { scopes: [read] }` or `[write, destructive]`, and the server is launched with `--scope read --scope write`; global mappings match operation names by `pattern` (e.g. `"^get|^list"` -> `[read]`).
- Search snippets of official Gram docs (https://www.speakeasy.com/docs/gram/concepts/tool-sources; direct fetch 404): `x-gram` at operation level overrides tool `name` and `description` without altering the OpenAPI text and adds `responseFilterType` (example value `jq`) to filter responses for the model; without it a tool is named like `ecommerce_e_commerce_v1_product` ("poor quality tool"); toolsets and "tool variations" curate and rename outside the spec.
- Lesson: the industry convention for agent annotations on OpenAPI is a vendor `x-` object per operation with name/description overrides and a read/write/destructive scope vocabulary; Answerable's `x-kind` / `x-scopes` fit that pattern.

### Stainless
- VERIFIED (https://www.stainless.com/docs/mcp/): the current generator uses a "code tool architecture": a code-execution tool that runs TypeScript against the generated SDK (`--code-execution-mode local` in a Deno subprocess; `stainless-sandbox` deprecated) plus a docs-search tool, on the argument that few tools cost less context and one call can perform several operations.
- Search snippets of the changelog (https://www.stainless.com/changelog/mcp-dynamic-tools): the earlier "dynamic tools" mode (`--tools=dynamic`) exposed `list_api_endpoints`, `get_api_endpoint_schema`, `invoke_api_endpoint` so the model discovers and calls endpoints on demand without the whole schema in context.
- Lesson: "describe + invoke" meta-tools are the REST-world twin of Apollo's `search` + `introspect` + `execute`; both exist to solve tool explosion, not to give the model more expressive power.

### OpenAI `x-openai-isConsequential`
- VERIFIED (https://developers.openai.com/api/docs/actions/production, "Consequential flag"): per-operation OpenAPI extension `x-openai-isConsequential`; when `true` ChatGPT always prompts for confirmation before running and shows no "always allow" button; when `false` the "always allow" button is shown; when absent "ChatGPT defaults all GET operations to `false` and all other operations to `true`". Exact name confirmed.
- Lesson: the one widely deployed OpenAPI agent annotation is a boolean consequence flag with a safe default by HTTP method; Answerable's `x-kind` (read / write / destructive) is a superset and should map to it (`x-kind != read` -> consequential).

## 7. Error taxonomies

### Google `google.rpc.Status` + `ErrorInfo` (AIP-193)
- VERIFIED (https://google.aip.dev/193): services "must" use `google.rpc.Status` with a `google.rpc.Code`; every error "must" include `ErrorInfo` in `details`; `reason` is UPPER_SNAKE_CASE, "at most 63 characters and match a regular expression of `[A-Z][A-Z0-9_]+[A-Z0-9]`" (examples `CPU_AVAILABILITY`, `NO_STOCK`); `domain` is the service (`pubsub.googleapis.com`); the (reason, domain) pair is the stable machine identity; request-specific values that appear in the message "must be represented within `metadata`"; `Status.message` is for developers, `LocalizedMessage` for end users; services "should not support partial errors" (put them in LRO metadata); permission checks precede existence checks and return `PERMISSION_DENIED`.
- VERIFIED (https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/code.proto): OK 200, CANCELLED 499, UNKNOWN 500, INVALID_ARGUMENT 400, DEADLINE_EXCEEDED 504, NOT_FOUND 404, ALREADY_EXISTS 409, PERMISSION_DENIED 403, UNAUTHENTICATED 401, RESOURCE_EXHAUSTED 429, FAILED_PRECONDITION 400, ABORTED 409, OUT_OF_RANGE 400, UNIMPLEMENTED 501, INTERNAL 500, UNAVAILABLE 503, DATA_LOSS 500. The retry rule in the proto comments: use UNAVAILABLE "if the client can retry just the failing call", ABORTED "if the client should retry at a higher level" (restart a read-modify-write sequence after a failed test-and-set), FAILED_PRECONDITION "if the client should not retry until the system state has been explicitly fixed".
- VERIFIED (https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/error_details.proto): `ErrorInfo{reason, domain, metadata}` (reason "identifies the proximate cause", unique within a domain, `[A-Z][A-Z0-9_]+[A-Z0-9]`, <= 63 chars; metadata keys `[a-z][a-zA-Z0-9-_]+`, lowerCamelCase), `RetryInfo{retry_delay}`, `DebugInfo`, `QuotaFailure{violations[]}`, `PreconditionFailure{violations[]{type, subject, description}}`, `BadRequest{field_violations[]{field, description, reason, localized_message}}`, `RequestInfo{request_id, serving_data}`, `ResourceInfo{resource_type, resource_name, owner, description}`, `Help{links[]}`, `LocalizedMessage{locale, message}`.
- Note: cloud.google.com/apis/design/errors now redirects to AIP-193.

### RFC 9457 Problem Details
- VERIFIED (https://www.rfc-editor.org/rfc/rfc9457.html): `application/problem+json` with `type` (URI, default `about:blank`), `status`, `title`, `detail`, `instance`, plus extension members clients must ignore when unknown; "Consumers MUST use the 'type' URI ... as the problem type's primary identifier"; use it when the status code alone is not enough; IANA registry of common problem types.

### Stripe
- VERIFIED (https://github.com/stripe/stripe-ruby/issues/503, via gh api): a reused key with different parameters returns HTTP 400 with the message "Keys for idempotent requests can only be used with the same parameters they were first used with..." (type `idempotency_error`), i.e. Stripe uses 400 where the IETF draft says 422.
- VERIFIED (https://docs.stripe.com/error-low-level): for POSTs with an idempotency key, results are cached "as soon as an API method has started executing", so a 400 is replayed as the same 400 with the same key and the client must mint a new key after changing the request; 429 and most 401/400 responses happen before the idempotency layer and can differ on retry; 5xx results are cached too and 500 outcomes are "indeterminate" (Stripe reconciles and emits webhooks); replayed responses carry `Idempotent-Replayed: true`; the `Stripe-Should-Retry` header is `true` (retry with backoff), `false` (do not retry) or absent (decide from the status); same key with different parameters -> an error that the request does not match the original; 409 when the same key is still in flight.
- VERIFIED (https://docs.stripe.com/api/errors): `type` in {`api_error`, `card_error`, `idempotency_error`, `invalid_request_error`}; `code` (machine-readable), `decline_code`, `advice_code`, `message` (human), `param` (which field), `doc_url`, `request_log_url`, attached `payment_intent` / `setup_intent`; HTTP 400, 401, 402, 403, 404, 409 ("perhaps due to using the same idempotent key"), 424, 429 (exponential backoff), 500/502/503/504. `idempotency_error` "occur when an `Idempotency-Key` is re-used on a request that does not match the first request's API endpoint and parameters".

### MCP
- VERIFIED (2025-06-18 tools page and 2025-11-25 changelog, above): tool execution errors and input validation errors go in the result with `isError: true` (so the model can self-correct); protocol errors (`-32602` etc.) only for unknown tool / malformed request; `structuredContent` should conform to `outputSchema`, so an error envelope must be part of the declared output schema (or delivered as text when `isError` is set).

## Recommended prepared-mutation protocol

Every state-changing capability `X` exposes `X.prepare` and `X.commit` (plus shared `intents.get`, `intents.cancel`, `operations.get`). Read capabilities are unchanged. Field names below are proposals; the bracketed source is the prior art each element mirrors.

### `prepare` request
| Field | Notes |
| --- | --- |
| `input` | Validated against the capability's input schema. |
| `idempotency_key` | Optional client UUID v4. Same key + same fingerprint within the retention window returns the stored intent; same key + different fingerprint -> `IDEMPOTENCY_KEY_MISMATCH` (422). [IETF Idempotency-Key, AIP-155, Stripe] |
| `expected_versions[]` | Optional preconditions the caller already holds (`{resource, kind, value}`); prepare fails with `INTENT_STALE` if they no longer match. [HTTP If-Match, AIP-154] |
| `validate_only` | Optional; run authorisation, target resolution and preview but persist nothing and mint no token; unknowable fields omitted. [AIP-163, Kubernetes dryRun] |

### `prepare` response: the mutation intent
| Field | Notes |
| --- | --- |
| `intent_id` | Server-generated, >= 128 bits of entropy, bound to the authorisation context. [MCP tasks, OB ConsentId] |
| `capability`, `capability_version` | Which code path the token is valid for. |
| `principal` | `{subject, organisation, client_id, scopes}` at prepare time. |
| `input` (canonical), `input_fingerprint` | `sha256(JCS(input))`, RFC 8785. Never hash raw text. |
| `targets[]` | `{resource_type, resource_id, label, version: {kind: etag \| version \| timestamp \| serial, value}}` for every resource the commit will read or write. [Terraform prior state serial/lineage, AIP-154, Kubernetes resourceVersion] |
| `preview` | `{changes[] (path, before, after), effects[] (side effects such as notifications, cascades, external calls, money), warnings[], quantities}`. Same authorisation and validation path as commit. [AIP-163, dryRun sideEffects] |
| `policy_class` | `AGENT_COMMITTABLE \| CONTROLLED \| HUMAN_APPROVAL_REQUIRED`, decided server-side from capability metadata (`x-kind`) and the preview (thresholds), never by the client. [ADK callable `require_confirmation`, Speakeasy scopes, x-openai-isConsequential] |
| `approval` | `{required, status: not_required \| pending \| granted \| denied, url?, approver_requirements?, approval_id?}`. `url` is an Answerable ID page for HUMAN_APPROVAL_REQUIRED. [OB consent authorisation, MCP URL-mode elicitation] |
| `commit_token` | Opaque, single use, bound to the record (see approval binding). Present for every class; commit still checks `approval.status`. [OB consent, PayPal authorisation id] |
| `expires_at` | Short by default (suggest 10 min for agent-committable, up to 24 h once a human approval is granted; capability-configurable). [PayPal 3-day honour period, Stripe 24 h, MCP task ttl] |
| `status` | `prepared` (see state machine). |
| `batch` | For batch previews: `items[]` each with its own `targets`, `preview`, `policy_class`; the intent's class is the maximum; one token. Default all-or-nothing. [AIP-193 "no partial errors"] |

### `commit` request
`{intent_id, commit_token, idempotency_key?}` and nothing else: no new options or inputs, exactly like `terraform apply plan.out`. A repeated commit of the same intent by the same principal is a retry and returns the stored receipt with `idempotent_replay: true`. [Terraform, Stripe `Idempotent-Replayed`]

### `commit` response: the receipt
| Field | Notes |
| --- | --- |
| `receipt_id`, `intent_id` | Receipts are immutable and retained for audit. |
| `status` | `committed \| pending \| indeterminate`. `pending` carries `operation`; `indeterminate` means the upstream call may or may not have applied (Stripe treats 500 as indeterminate) and the operation will reconcile. |
| `results` | Created ids, new versions/etags of every target (so the agent can chain into the next `prepare` with `expected_versions`). |
| `applied_changes[]`, `effects_performed[]` | Which previewed changes/effects happened; differences from the preview are listed explicitly. |
| `committed_at`, `committed_by`, `approved_by?`, `approval_id?` | Audit trail. |
| `operation` | `{operation_id, status: working \| completed \| failed \| cancelled, poll_after_ms, ttl, status_message}`; `operations.get` returns the same object and, when terminal, the receipt. Mirror MCP tasks field for field so clients with task support map 1:1, and expose `execution.taskSupport: "optional"` on commit tools once the SDK supports it. [AIP-151, MCP tasks] |
| `idempotent_replay` | `true` when a stored receipt is returned. |

### Intent state machine
`prepared` -> `awaiting_approval` (HUMAN_APPROVAL_REQUIRED only) -> `approved` -> `committing` -> `committed`; side exits `denied`, `cancelled`, `expired`, `stale` (detected at commit or on `intents.get`), `failed` (commit started and the upstream rejected it). Terminal states never transition; a stale, expired, denied or failed intent is never revived, the agent must `prepare` again. Commit takes a row lock on the intent and marks it `committing` before touching upstream, so concurrent commits get `COMMIT_IN_PROGRESS`. Re-authorisation at commit: the principal must match (`subject`, `organisation`, `client_id`), the capability's scopes must still be entitled, and every `targets[].version` must still match (re-read upstream; compare typed values). [MCP tasks context binding, Terraform serial check, AIP-154 ABORTED]

### Error codes (`code`, HTTP, `retry.policy`)
| Code | HTTP / rpc | Retry hint | Mirrors |
| --- | --- | --- | --- |
| `INVALID_INPUT` | 400 INVALID_ARGUMENT | `after_fix_input` with `details.field_violations[]` | BadRequest, MCP SEP-1303 (tool error, not protocol error) |
| `TARGET_NOT_FOUND` | 404 NOT_FOUND | `never` | |
| `PERMISSION_DENIED` | 403 PERMISSION_DENIED | `never` | AIP-193 (check permission before existence) |
| `PRECONDITION_FAILED` | 400 FAILED_PRECONDITION | `after_state_change` with `details.preconditions[]` | PreconditionFailure, code.proto rule (c) |
| `INTENT_STALE` | 409 ABORTED | `after_reprepare` with `details.targets[]` (expected vs current) | AIP-154, Kubernetes 409, HTTP 412, Terraform "Saved plan is stale" |
| `INTENT_EXPIRED` | 410 (or 409) | `after_reprepare` | OB consent expiry, MCP task expired |
| `INTENT_NOT_FOUND` | 404 | `after_reprepare` | MCP tasks -32602 |
| `COMMIT_TOKEN_INVALID` | 403 | `never` | |
| `PRINCIPAL_MISMATCH` | 403 | `never` | MCP tasks context binding |
| `APPROVAL_REQUIRED` | 403 with `details.approval.url` | `after_approval` | OB InvalidConsentStatus, Claude Code requiresUserInteraction |
| `APPROVAL_DENIED` | 403 | `never` | |
| `INTENT_CANCELLED` / `INTENT_CONSUMED` | 409 | `after_reprepare` | OB Consumed |
| `COMMIT_IN_PROGRESS` | 409 | `after_delay` | IETF 409 concurrent, Stripe 409 |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 | `never` (mint a new key) | IETF draft 422, Stripe 400 idempotency_error |
| `UPSTREAM_REJECTED` | 424 (or 502) with `details.upstream` | `never` | Stripe 424 |
| `UPSTREAM_UNAVAILABLE` | 503 UNAVAILABLE | `after_delay` with `retry.after_ms` | RetryInfo, code.proto rule (a) |
| `RATE_LIMITED` | 429 RESOURCE_EXHAUSTED | `after_delay` | QuotaFailure |
| `OPERATION_NOT_FOUND` / `OPERATION_EXPIRED` | 404 | `never` | MCP tasks |
| `INTERNAL` | 500 | `after_delay`, receipt status `indeterminate` | Stripe 500 guidance |

Envelope (one shape everywhere): `{ error: { code, domain: "answerable", status: "ABORTED", http: 409, message, details: {...}, retry: { policy, after_ms? }, request_id, docs_url } }`. Over MCP it is the `structuredContent` of a result with `isError: true` (and repeated as text); over HTTP it is `application/problem+json` with `type: https://answerable.dev/errors/<code>`, `title`, `status`, `detail`, `instance = request_id` and the same extension members. `retry.policy` values: `never`, `after_delay`, `after_fix_input`, `after_state_change`, `after_reprepare`, `after_approval`, deliberately more specific than Google's three-way rule and Stripe's `Stripe-Should-Retry` so a model can pick the next action without reading prose.

### MCP surface details
- `X.commit` for HUMAN_APPROVAL_REQUIRED capabilities carries `_meta["anthropic/requiresUserInteraction"]: true` (ignored by other clients) and annotations `readOnlyHint: false`, `destructiveHint` per `x-kind`, `idempotentHint: true` (commit is idempotent by intent id). `X.prepare` is `readOnlyHint: true`, `idempotentHint: true`.
- Output schemas include the error envelope as a variant so `structuredContent` validates in both cases.
- Long-running commits: return `operation` immediately; add `execution.taskSupport: "optional"` when TypeScript SDK 2.x exposes 2025-11-25 tasks.

## Recommended approval binding

1. Token design: `commit_token` is an opaque random string (32 bytes, base64url, prefixed for log hygiene, e.g. `act_`), stored only as a hash (like an API key). The server record it points to holds `intent_id`, `principal {subject, organisation, client_id}`, `capability`, `capability_version`, `input_fingerprint`, `targets[].version`, `policy_class`, `expires_at`, `approval` state, `used_at`. Single use: `commit` consumes it in the same transaction that marks the intent `committing`. Do not use a JWT: the preview is sensitive (Terraform warns plan files hold cleartext secrets), nothing needs to be verified offline, and revocation/expiry are trivial with a record. [MCP tasks context binding, OB single-use consent, Stripe stored responses]
2. Intent digest: `intent_digest = sha256(JCS({capability, capability_version, input_fingerprint, targets, preview}))`. Compute over the canonical form (RFC 8785); carry 64-bit integers as strings. The digest is what an approver approves.
3. Approval record (HUMAN_APPROVAL_REQUIRED): `{approval_id, intent_id, intent_digest, approver {subject, organisation, auth_time, amr}, decision, decided_at, expires_at, channel}` written by an authenticated Answerable ID session on a server-rendered approval page (Hono, in `apps/id` or a shared approvals service; open question below). Commit checks `approval.intent_digest == current intent_digest`, `decision == granted`, not expired, and that the approver satisfies the capability's approver requirements (role/group, not the same principal as the agent's user when four-eyes is required). Any change to input or targets produces a new intent and invalidates the approval automatically, which is the Open Banking "Initiation must not change" rule and AP2's `checkout_hash` binding.
4. Channels: for HUMAN_APPROVAL_REQUIRED the decision must come from Answerable ID (web page opened from `approval.url`, or later a signed deep link). MCP elicitation may carry the hand-off (URL mode in 2025-11-25; form mode as a "have you approved?" nudge) but never the decision, because clients may not implement it, the server cannot tell who answered, and nothing binds the answer to a tool call. For CONTROLLED, the client's own prompt (Claude Code permission prompt, OpenAI `needs_approval`, AI SDK `toolApproval`, MAF `ApprovalRequiredAIFunction`) is sufficient and the server records `approval.channel = "client"`; `_meta["anthropic/requiresUserInteraction"]` makes Claude Code's prompt unbypassable, and `x-openai-isConsequential: true` does the same for GPT Actions.
5. Portable approvals (only if needed later): sign `{intent_id, intent_digest, approver, exp, cnf}` as a JWS (RFC 7515) or SD-JWT as AP2 does, or have Answerable ID issue an access token with RFC 9396 `authorization_details: [{type: "answerable_intent", identifier: intent_id, digest}]`. Biscuit-style attenuation is the right model if an approval must be delegated with narrower rights, but it is not needed for a single-service design.
6. Error taxonomy for the binding (from prior art): stale (`INTENT_STALE`, ABORTED/409/412), expired (`INTENT_EXPIRED`), mismatch (`IDEMPOTENCY_KEY_MISMATCH` 422; `PRINCIPAL_MISMATCH` 403; `COMMIT_TOKEN_INVALID` 403), already committed (`idempotent_replay` receipt for the same principal, `INTENT_CONSUMED` 409 otherwise), pending approval (`APPROVAL_REQUIRED` 403 + url), in flight (`COMMIT_IN_PROGRESS` 409).

## GraphQL / query-surface recommendation

- Fixed capabilities stay primary. Writes are only ever `prepare`/`commit`; no mutation reaches upstream through a query surface (Apollo `mutation_mode: none`, Grafbase `execute_mutations = false`, Cosmo predefined operations are the industry defaults for a reason).
- Add an optional read-only typed query surface with two tools: `describe` (search-scoped schema subsets with a hard context cap, minified, per-principal visibility, no hidden fields; Apollo `search`/`introspect` + `minify`, Grafbase `search` with decay by depth) and `query` (validates before executing like Apollo `validate`, enforces depth and breadth limits, cost budget, pagination caps, timeouts, alias/batch limits and rate limits per OWASP; field-level authorisation in resolvers; `response_format: concise | detailed`; results carry `resource_versions` so `prepare` can take them as `expected_versions`). The schema is Answerable's own projection of capability types; resolvers call capabilities, so upstream REST/GraphQL/OData never leaks and Answerable ID scopes still apply.
- Promotion path: an operator (or the agent, via a CONTROLLED capability) can save a validated query as a named fixed read capability, which is Apollo's operation-collections idea and keeps the model-facing surface converging on fixed tools.
- When `describe` + `query` beats fixed tools: read-heavy, cross-entity, unpredictable-shape questions (reporting, reconciliation across CRM/documents/construction records), when the fixed read set would exceed roughly 30-50 tools, and when field projection materially cuts tokens. When it does not: any write, consumer-facing narrow flows (Shopify shipped five fixed tools), small APIs, and clients with weak multi-step reasoning (BFCL: multi-turn and long-horizon remain open problems; NL2GraphQL: 31-48%).
- Offering both: tool list = fixed capabilities + `describe` + `query`; gate the query surface behind a scope/toolset so clients that do not need it never see it; log every `query` document for audit and for promotion candidates; consider PromptQL-style plan execution (model writes a plan, engine runs it) only if measured accuracy on Answerable's own eval set justifies it.

## Open questions

1. Where do intents, approvals and receipts live: one store per MCP (each `mcps/*` service with its own Postgres) or a shared "mutations" service, given that HUMAN_APPROVAL_REQUIRED needs an Answerable ID session and `apps/id` owns all identity pages? A shared approvals API in `apps/id` with the intent digest as the only payload keeps previews out of ID.
2. Default TTLs per policy class and per capability, and whether a granted approval extends `expires_at`.
3. Batch semantics per capability: all-or-nothing by default; which capabilities may declare partial application, and how the receipt reports it.
4. Should the read surface's `resource_versions` be mandatory inputs to `prepare` (strict read-then-prepare) or optional hints?
5. How to get the server-computed preview in front of a human in clients that only display tool inputs (Claude Code shows the commit call's arguments, not the earlier prepare result). Options: the approval page for HUMAN_APPROVAL_REQUIRED; for CONTROLLED, have `commit` accept an optional `preview_summary` echoed from the prepare result and re-verified against the intent (mismatch -> reject), so the client prompt shows server-authored text.
6. MCP 2025-11-25 tasks and URL-mode elicitation: SDK 2.1 support status and whether to depend on them now or keep `operation_id` polling only.
7. Machine-checkable `effects[]` vocabulary (notification, external_call, money_movement, cascade_delete, permission_change) and how policy thresholds reference it.
8. Whether Answerable ID should issue per-intent tokens (RFC 9396) for third-party commit paths, or whether the opaque record is enough for the foreseeable roadmap.
9. Query-surface numbers: depth, cost budget, page caps, and which capability types are projected first.
10. Retention of receipts and idempotency records (24 h like Stripe/OB for idempotency keys; longer for receipts as audit evidence).

## Sources

Section 1
- https://kubernetes.io/docs/reference/using-api/api-concepts/ (dry run; resource versions)
- https://kubernetes.io/docs/reference/using-api/server-side-apply/
- https://developer.hashicorp.com/terraform/cli/commands/plan
- https://developer.hashicorp.com/terraform/cli/commands/apply
- https://raw.githubusercontent.com/hashicorp/terraform/main/internal/backend/local/backend_local.go
- https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header (draft-07)
- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/error-low-level
- https://github.com/stripe/stripe-ruby/issues/503
- https://google.aip.dev/163, https://google.aip.dev/151, https://google.aip.dev/155, https://google.aip.dev/154
- https://openbankinguk.github.io/read-write-api-site3/v3.1.10/resources-and-data-models/pisp/domestic-payment-consents.html
- https://openbankinguk.github.io/read-write-api-site3/v3.1.10/resources-and-data-models/pisp/domestic-payments.html
- https://openbankinguk.github.io/read-write-api-site3/v3.1.10/profiles/read-write-data-api-profile.html
- https://developer.paypal.com/docs/checkout/standard/customize/authorization/
- https://docs.adyen.com/online-payments/capture/

Section 2
- https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- https://openai.github.io/openai-agents-python/human_in_the_loop/
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/mcp (Require approval for a specific tool)
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://vercel.com/blog/ai-sdk-6
- https://www.inngest.com/docs/reference/functions/step-wait-for-event
- https://docs.temporal.io/encyclopedia/workflow-message-passing
- https://docs.temporal.io/develop/typescript/message-passing
- https://typescript.temporal.io/api/namespaces/workflow#condition
- https://adk.dev/tools-custom/confirmation/
- https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools (no confirmation guidance)
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts
- https://modelcontextprotocol.io/specification/2025-11-25/changelog
- https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

Section 3
- https://www.rfc-editor.org/rfc/rfc8785.html
- https://www.rfc-editor.org/rfc/rfc9396.html
- https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/specification.md
- https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/docs/ap2/checkout_mandate.md
- https://doc.biscuitsec.org/ and https://doc.biscuitsec.org/getting-started/introduction

Section 4
- https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match
- https://learn.microsoft.com/en-us/graph/api/resources/planner-overview
- https://learn.microsoft.com/en-us/graph/api/resources/driveitem
- https://learn.microsoft.com/en-us/graph/api/listitemversion-get
- https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest_conditional_requests.htm (search snippet; fetch blocked)
- https://aps.autodesk.com/llms.txt and https://aps.autodesk.com/developer/overview/data-management-api (snippet)
- https://developers.procore.com/reference/rest/rfis and https://procore.github.io/documentation/webhooks (snippets)

Section 5
- https://www.apollographql.com/docs/apollo-mcp-server
- https://www.apollographql.com/docs/apollo-mcp-server/define-tools
- https://www.apollographql.com/docs/apollo-mcp-server/config-file
- https://www.apollographql.com/blog/building-efficient-ai-agents-with-graphql-and-apollo-mcp-server
- https://grafbase.com/docs/gateway/mcp
- https://grafbase.com/blog/managing-mcp-context-graphql
- https://cosmo-docs.wundergraph.com/router/mcp
- https://promptql.io/blog/how-promptql-achieves-100-accuracy-for-ai-on-enterprise-data
- https://shopify.dev/docs/apps/build/storefront-mcp
- https://raw.githubusercontent.com/github/github-mcp-server/main/README.md
- https://dl.acm.org/doi/10.1145/3814574.3816745 (abstract via search; fetch blocked)
- https://research.ibm.com/publications/robust-evaluation-of-llm-generated-graphql-queries-for-web-services
- https://proceedings.mlr.press/v267/patil25a.html
- https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html

Section 6
- https://gofastmcp.com/integrations/openapi
- https://raw.githubusercontent.com/harsha-iiiv/openapi-mcp-generator/main/README.md
- https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi
- https://www.speakeasy.com/docs/gram/concepts/tool-sources (snippet; fetch 404)
- https://www.stainless.com/docs/mcp/ and https://www.stainless.com/changelog/mcp-dynamic-tools (snippet)
- https://developers.openai.com/api/docs/actions/production (Consequential flag)

Section 7
- https://google.aip.dev/193
- https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/code.proto
- https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/error_details.proto
- https://www.rfc-editor.org/rfc/rfc9457.html
- https://docs.stripe.com/api/errors
