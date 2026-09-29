# MCP platform research

Retrieval date: 2026-09-28. Method: official pages read through Google Chrome computer-use tools only. No claims are based on memory. Findings saved incrementally after every two pages; final status and remaining gaps appear at the end.

## Access log
- Initial Chrome launch returned: Unable to load browser request-header policy. Retrying.

## 1. Palantir Foundry

### Observed facts
- https://www.palantir.com/docs/foundry — retrieved 2026-09-28; no publication date/version shown (footer © 2026). Documentation index links Ontology, security, and AIP sections. Navigation page read.
- https://www.palantir.com/docs/foundry/ontology/overview/ — retrieved 2026-09-28; no publication date/version shown (footer © 2026). Ontology maps integrated datasets, virtual tables, and models to objects, properties, and links; action types capture operator input and orchestrate decisions connected to existing systems; functions hold business logic. Quote: “an operational layer for the organization”.

### Inferences
- An Answerable domain-action layer can offer stable business operations independently of the AI client, rather than exposing only underlying service APIs (derived from Ontology overview).

### Could not verify
- Initial checkpoint superseded by the detailed action, agent, OSDK and security findings below; see Palantir residual.

Access update: native Chrome computer-use works; browser-tab API remains unavailable. Palantir cookie banner rejected. First two official pages read and saved.

### Observed facts — actions (pages 3–4)
- https://www.palantir.com/docs/foundry/action-types/overview — retrieved 2026-09-28; no publication date/version shown. Actions are transactions updating objects, properties, and links; action types define those changes and submission side effects. The same action logic and validation can be reused across applications. Quote: “a single transaction”.
- https://www.palantir.com/docs/foundry/action-types/submission-criteria/ — retrieved 2026-09-28; no publication date/version shown. Submission criteria (formerly validations) must all pass and are distinct from permission to edit an action type. They combine current-user identity/group/attributes, parameters, and execution context; can check live object state. Missing access to a user attribute fails its condition. Scoped tokens may omit memberships, so negated membership checks can unintentionally grant access. Attachment and object-set parameters are unsupported in submission criteria. Failures have configured messages. Quote: “Avoid using NOT conditions”.

### Inferences — actions
- Toolbox should enforce domain preconditions and caller authorization at commit time across every client; tool visibility alone is insufficient (submission criteria page).
- Prefer positive grants for scoped identities; missing claims must not accidentally satisfy a deny-list-style rule (submission criteria page).

### Observed facts — parameters and side effects (pages 5–6)
- https://www.palantir.com/docs/foundry/action-types/parameter-overview/ — retrieved 2026-09-28; no publication date/version shown. Parameters are typed inputs reusable in rules, submission criteria, and overrides; individual inputs can be hidden or made uneditable. Host applications can pass previous property values through hidden parameters. No quotation.
- https://www.palantir.com/docs/foundry/action-types/side-effects-overview/ — retrieved 2026-09-28; no publication date/version shown. Side effects include notifications (including email) and webhooks to external REST APIs, ERP, or messaging systems. This overview does not establish transactional guarantees for external effects. No quotation.

### Inferences — parameters and side effects
- Model mutation inputs and external effects explicitly in the preview/receipt contract. Do not infer that an external webhook is atomic with an Ontology transaction from this overview.

### Observed facts — audit and permissions (pages 7–8)
- https://www.palantir.com/docs/foundry/action-types/action-log/ — retrieved 2026-09-28; no publication date/version shown. Configured action logs record successful submissions, including API/SDK submissions, but not failures or direct datasource writes. Each submission produces one log object linked to edited objects. Required fields include action ID, action type ID/version, UTC time, user, edited-object keys, and side-effect/revert provenance; parameters and selected context are optional. Logging can be required for actions editing a particular object type; no historical backfill. No quotation.
- https://www.palantir.com/docs/foundry/action-types/permissions/ — retrieved 2026-09-28; no publication date/version shown. Submitters must view affected types/datasources and pass criteria; extra writeback/edit-policy permissions depend on configuration. Row/column controls filter reads but do not extend to writes; read/write authorizations constrain marked inputs and output security. Missing permissions on the log object type causes submission failure. Failed criteria prevent side effects; notification failures need not prevent successful edits. Quote: “Read-time enforcement only”.

### Inferences — audit and permissions
- Receipts should include stable operation/version IDs, caller, timestamp, affected entities, and external-effect outcomes. Maintain separate failed-attempt audit records (action log page).
- Read authorization and write authorization need separate checks; do not assume filtered input implies safe output (permissions page).

### Observed facts — security and roles (pages 9–10)
- https://www.palantir.com/docs/foundry/security/overview — retrieved 2026-09-28; no publication date/version shown. Mandatory controls (markings, classifications, organizations) propagate with data derivation; discretionary resource roles and row/column policies do not follow downstream outputs/exports. No quotation.
- https://www.palantir.com/docs/foundry/security/projects-and-roles/ — retrieved 2026-09-28; no publication date/version shown. Default roles are Owner, Editor, Viewer, Discoverer; custom roles are independent operation sets, not necessarily a hierarchy. Mandatory controls deny ineligible users regardless of role. Project role grants inherit to contained resources; group grants at project level are recommended. No quotation.

### Inferences — security and roles
- Separate administrative capabilities from mandatory tenant/data restrictions. Carry data restrictions through run_code outputs and receipts where required; ordinary tool grants do not solve downstream disclosure.

### Observed facts — markings and restricted views (pages 11–12)
- https://www.palantir.com/docs/foundry/security/markings/ — retrieved 2026-09-28; no publication date/version shown. All applied markings must be satisfied, in addition to role grants. Markings propagate through hierarchy and data dependencies; resource ownership alone cannot remove them without the marking's Expand Access permission. Markings restrict eligibility rather than provision access. No quotation.
- https://www.palantir.com/docs/foundry/security/restricted-views/ — retrieved 2026-09-28; no publication date/version shown. Policies compare caller attributes, columns, and constants to filter rows; identity references use UUIDs rather than names. These read filters do not propagate into action/function/AIP Logic outputs, OSDK responses, writeback, or exports. Consumers restricted to a view should not have upstream dataset access. No quotation.

### Inferences — markings and restricted views
- For Toolbox, combine positive per-user tool grants with tenant/data eligibility checks and query-time filtering; protect the unfiltered upstream path separately.

### Observed facts — AIP tooling (pages 13–14)
- https://www.palantir.com/docs/foundry/aip/overview — retrieved 2026-09-28; no publication date/version shown. AIP Agent Studio is now called AIP Chatbot Studio; AIP tools integrate with the Ontology and existing security/audit controls. Feature availability may differ between customers. No quotation.
- https://www.palantir.com/docs/foundry/chatbot-studio/tools — retrieved 2026-09-28; no publication date/version shown. Builders configure action, object-query, function (including published AIP Logic), application-variable, command, and clarification tools. Actions can run automatically or require user confirmation. Object-query tools specify accessible types/properties. Prompted tool mode invokes one tool at a time; native mode allows parallel calls on supported models/tool types. No quotation.

### Inferences — AIP tooling
- Curated domain tools plus optional confirmation are transferable; object/tool configuration should minimize exposed context, with backend caller authorization enforced separately.

### Observed facts — execution identity (pages 15–16)
- https://www.palantir.com/docs/foundry/chatbot-studio/overview/ — retrieved 2026-09-28; no publication date/version shown. Chatbots can be deployed internally or via APIs/SDK; overview says platform security limits LLM access to task requirements, but does not specify the full action caller-token flow. No quotation.
- https://www.palantir.com/docs/foundry/logic/core-concepts/ — retrieved 2026-09-28; no publication date/version shown. Logic functions that edit Ontology must be published and called from an action. User-scoped execution uses the running user's permissions; project-scoped execution uses the containing project's permissions, also affecting execution-log visibility. No quotation.

### Inferences — execution identity
- Do not describe all Palantir agent execution as inherently user-scoped: Logic has an explicit project-scoped option. Toolbox should make execution identity visible and auditable.

### Observed facts — OSDK (pages 17–18)
- https://www.palantir.com/docs/foundry/ontology-sdk/overview — retrieved 2026-09-28; no publication date/version shown. OSDK tokens restrict access to selected Ontology entities in addition to the user's own data permissions. Row/column checks constrain reads but do not attach protection to response payloads or subsequent application handling. No quotation.
- https://www.palantir.com/docs/foundry/agents/scoped-permissions — retrieved 2026-09-28; no publication date/version shown. Pro-code-agent templates resolve platform-managed credentials and connection details for OSDK/Ontology MCP/Palantir MCP; application code need not provision a client secret or Foundry token. Access depends on published execution mode and underlying-client restrictions. No quotation.

### Inferences — OSDK
- Use intersection semantics: app/tool scope AND caller rights. Keep platform-managed credentials out of sandbox code where possible.

### Could not verify — Palantir residual
- Chatbot Studio overview did not establish the exact token handoff for each action invocation; action enforcement and Logic execution modes are separately documented above. No claim that every agent call uses an end-user token.

## 2. Anthropic

### Observed facts
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp — retrieved 2026-09-28; stated date August 11, 2026. Remote connections originate in Anthropic's cloud, including Desktop/Cowork; servers need public reachability from Anthropic IP ranges. Team/Enterprise Owners or Primary Owners add custom connectors at organization level; members then authenticate individually. Advanced settings accept optional OAuth client ID/secret. Users can toggle connectors per conversation and disable tools. Owners can disable tool calls rendering interactive interfaces. No quotation.

### Inferences
- Toolbox needs a cloud-reachable endpoint for Claude custom connectors; a user's VPN reachability alone is insufficient. Organization installation and individual authorization are distinct steps.

### Could not verify
- https://support.claude.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers returned a 404 on 2026-09-28. Setup article links replacement https://claude.com/docs/connectors/building (subsequently read below).

Save checkpoint: 19 official content pages read; one official 404 inspected. Google results used only to locate official pages, not as factual evidence.

### Observed facts — protocol and authentication (pages 20–21)
- https://claude.com/docs/connectors/building — retrieved 2026-09-28; no date/version shown; references MCP authorization versions 2025-03-26, 2025-06-18, 2025-11-25. Recommends Streamable HTTP; legacy HTTP+SSE supported but deprecated. Lists tools, prompts, resources, text/image results, text/binary resources, and MCP Apps UI. Unsupported list: resource subscriptions, sampling, advanced/draft capabilities. Hosted tool-result limit approximately 150,000 characters and tool timeout 240 seconds; Code output 25,000 tokens configurable by MAX_MCP_OUTPUT_TOKENS, timeout configurable by MCP_TOOL_TIMEOUT. No quotation.
- https://claude.com/docs/connectors/building/authentication#supported-authentication-types — retrieved 2026-09-28; no date/version shown. DCR is not the only OAuth registration option. CIMD requires both client_id_metadata_document_supported=true and token_endpoint_auth_methods_supported containing none; otherwise falls back to DCR. Supports pre-created confidential credentials held by Anthropic and customer-entered client credentials; these directory flows require contacting Anthropic. Hosted callback is https://claude.ai/api/mcp/auth_callback; Code uses loopback. S256 PKCE is required. Machine-to-machine client_credentials grant unsupported. Static request-header credentials are limited-organization beta and identify the organization, not the individual. No quotation.

### Inferences — interoperability
- Implement user OAuth with S256 PKCE and CIMD/DCR or explicitly configured credentials. Do not use organization-wide static keys as proof of individual identity.

### Could not verify — protocol residual
- Builder page does not explicitly name elicitation or tasks, nor a maximum tool count; its broad unsupported advanced/draft wording is insufficient to classify each feature.

### Observed facts — managed auth and Claude Code (pages 22–23)
- https://support.claude.com/en/articles/15537633-authorize-mcp-connectors-for-your-entire-organization — retrieved 2026-09-28; stated August 24, 2026. Enterprise-managed auth is GA for Team/Enterprise; admins provision by IdP roles/groups and scopes, with Okta supported at launch. Access still depends on IdP and connected-service policy; sessions end on token expiry/revocation. Any MCP provider can implement support. This is an alternative to the individually authenticated setup above. No quotation.
- https://code.claude.com/docs/en/mcp#installing-mcp-servers — retrieved 2026-09-28; no page date; body references v2.1.202, v2.1.206, v2.1.229 and v2.1.231. Read via Chrome screenshots because body text was missing from accessibility output. HTTP installation syntax: `claude mcp add --transport http <name> <url>`; `--header` supplies headers. At https://code.claude.com/docs/en/mcp#use-pre-configured-oauth-credentials, `--client-id`, `--client-secret` (masked prompt), and `--callback-port` support pre-registration; `/mcp` opens browser auth. CIMD also supported. Registered callback uses http://localhost:PORT/callback; v2.1.231 restored localhost after v2.1.229 used 127.0.0.1. At https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search, tool definitions are deferred; startup loads names/server instructions, no fixed per-server tool cap, practical constraint context budget. Descriptions and server instructions truncate at 2,048 characters by default. No quotation.

### Inferences — managed auth and search
- Managed organizational rollout need not imply a shared service identity. Preserve individual claims even when consent is centralized.
- Native client deferral already reduces schema context cost; evaluate Toolbox discovery/meta-tools on governance and workflow value as well as token reduction.

### Observed facts — API orchestration (pages 24–25)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool — retrieved 2026-09-28; versions tool_search_tool_regex_20251119 / tool_search_tool_bm25_20251119. Full deferred definitions still go in every request; defer_loading controls model context, not request payload. Server search returns tool_reference blocks expanded by the API. Limit 10,000 deferred tools; results default 5, adjustable 1–10,000; regex query max 200 characters, BM25 max 500. Custom search may return references to tools already defined in the request. No quotation.
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — retrieved 2026-09-28; versions code_execution_20260120 / code_execution_20260521 accepted interchangeably for allowed_callers. Claude writes sandboxed Python calling async tools; execution pauses for client tool results, then resumes; intermediate results stay out of model context. allowed_callers guides presentation, not a hard invocation security boundary. Pending continuation requires container ID and tools; tool results alone in the result message. Pending calls timeout around four minutes; idle containers around five minutes. strict:true, forced programmatic tool_choice, disable_parallel_tool_use:true, and recursive input-schema references have incompatibilities. No quotation.
- Additional read on https://code.claude.com/docs/en/mcp (same page, not a new page): plugin tools use `mcp__plugin_<plugin-name>_<server-name>__<tool-name>` with unsupported name characters replaced by underscores. Plugin server prefix differs from a bare server key.

### Inferences — API orchestration
- run_code should mediate and authorize every inner call; a declared caller preference is not an access-control mechanism. Design explicit suspend/resume deadlines and idempotency for retries.

### Could not verify — Code residual
- Bare-server `mcp__server__tool` form and exhaustive add flags not yet directly verified; only the flags and plugin form above were read.

## 3. OpenAI

### Observed facts (pages 26–27)
- https://developers.openai.com/api/docs/guides/developer-mode — retrieved 2026-09-28; no date/version shown. Developer mode supports read/write MCP tools over SSE/streaming HTTP, with OAuth, no auth, or mixed auth. Static client credentials, CIMD (none/private_key_jwt), and configured DCR are supported. It explicitly does not require search/fetch. App details allow tool toggles/refresh. Write calls require confirmation by default; absent readOnlyHint treated as write. No quotation.
- https://developers.openai.com/api/docs/mcp — retrieved 2026-09-28; no date/version shown. Deep research/company knowledge compatibility uses read-only search and fetch, unlike unrestricted developer mode. search takes query:string and returns `{results:[{id,title,url}]}`; fetch takes a document identifier string and returns `{id,title,text,url,metadata?}`. Return structuredContent plus equivalent JSON in a text content block, with output schemas. Nonempty canonical URL is required for citation metadata. OAuth CIMD recommended when supported/selected; configured DCR remains supported. No quotation.

### Inferences
- Provide search/fetch for research compatibility, but keep domain actions as first-class tools for developer mode. DCR is not universally required by current ChatGPT docs.

### Could not verify
- Initial checkpoint superseded by administration, Actions and tool-design findings below; see OpenAI residual.

### Observed facts — authentication and administration (pages 28–29)
- https://developers.openai.com/plugins/build/auth — retrieved 2026-09-28; no date/version shown. Authorization-code + S256 PKCE, protected-resource metadata, issuer/audience/expiry/scope validation required. CIMD preferred when supported/selected; DCR supported, once per connection with client reuse. Copy the exact redirect from management UI: callback-ID-specific https://chatgpt.com/connector/oauth/{callback_id}, or stable https://chatgpt.com/connector_platform_oauth_redirect when issuer-identification conditions apply (legacy published servers may retain stable URI). Server must authorize every request. No quotation.
- https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps — retrieved 2026-09-28; stated Updated: 20 days ago (relative text preserved). Workspace availability, role access, allowed actions, approval prompts, and provider scopes are separate controls. Business admins control workspace availability; Enterprise/Edu have role controls where supported. Custom apps may be created by owners/admins or explicitly permitted members under workspace policy. Supported action controls include read/write enablement and policies for new actions; not every app exposes individual action controls. Individual authorization, no-auth, and managed connections all exist. No quotation.

### Inferences — admin model
- Mirror these distinct controls in Toolbox: who can install, who can discover/use, which operations may execute, which require approval, and whose provider identity is used.

### Observed facts — Actions and publishing (pages 30–31)
- https://developers.openai.com/api/docs/actions/production — retrieved 2026-09-28; no date/version shown. GPT Actions OpenAPI `x-openai-isConsequential: true` requires confirmation every time and removes always-allow; false permits always-allow. When omitted, GET defaults false and other HTTP methods true. This is GPT Actions, not an MCP annotation. No quotation.
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt — retrieved 2026-09-28; stated Updated: last month. Only admins/owners publish workspace apps; Enterprise/Edu can delegate development access and select actions/groups before publishing. Published tool/input definitions are frozen until reviewed updates. New refreshed actions default disabled; incompatible live schema changes can break calls. No quotation.

### Inferences — prepared mutations
- Keep prepare/commit authorization and token binding on the server; a client confirmation mechanism or annotation alone does not provide an application-level transaction protocol.

### Could not verify — OpenAI residual and contradictions
- No numerical MCP tool-count guidance found in pages read.
- Help article's plan limitations and claim that OpenAI-built apps are search-only conflict with newer developer-mode/admin pages above. Preserve these differences; do not treat all help FAQ statements as current universal requirements.

## 4. Stacklok ToolHive

### Observed facts (pages 32–33)
- https://docs.stacklok.com/toolhive/ — retrieved 2026-09-28; no date/version shown (footer © 2026). ToolHive describes itself as Apache-2.0 open-source MCP/skills management core of Stacklok Enterprise, with isolated-container runtime, registry, and gateway. No quotation.
- https://docs.stacklok.com/toolhive/guides-vmcp/ — retrieved 2026-09-28; no date/version or preview label shown. vMCP aggregates multiple backends behind one endpoint with centralized auth and multi-step workflows; Kubernetes Operator is the cluster deployment path, local CLI for evaluation. Navigation also lists composite tools, optimizer, and Starlark code mode. No quotation.

### Inferences
- ToolHive's current gateway scope substantially overlaps Toolbox aggregation/orchestration; bespoke domain actions, governance UX, and prepared mutation semantics need separate evaluation as differentiators.

### Could not verify
- Formal GA/beta release status is not stated on the index; do not infer GA from absence of a preview label.

### Observed facts — workflows and identity (pages 34–35)
- https://docs.stacklok.com/toolhive/guides-vmcp/composite-tools — retrieved 2026-09-28; examples use toolhive.stacklok.dev/v1beta1. Composite workflows support parallel independent steps, dependencies, conditions, elicitation approval gates, loops, and abort/continue/retry behavior. Elicitation requires client support or workflow aborts. Default annotations derive conservatively from constituent tools; misleading less-conservative composites are omitted from discovery. forEach max parallel 50, max iterations 1000; forEach retry accepted by validation but ineffective at runtime. No quotation.
- https://docs.stacklok.com/toolhive/guides-vmcp/authentication — retrieved 2026-09-28; examples v1beta1. Incoming OIDC token validation is followed by Cedar authorization using validated groups/roles. Outgoing auth is per backend: shared secret, token exchange carrying real user identity, or delegated OAuth via embedded auth server. Header passthrough applies across backends at lowest precedence and preserves the original token's privileges; token exchange can narrow scope. No quotation.

### Inferences
- Reuse gateway infrastructure where suitable, but do not depend on elicitation-only approval for clients whose support is unverified. Prepared mutations can provide a separate cross-client approval contract.

### Observed facts — Cedar and operator (pages 36–37)
- https://docs.stacklok.com/toolhive/reference/authz-policy-reference — retrieved 2026-09-28; no date/version shown. Cedar principal is Client from token sub; tools use Tool entities and call_tool action. List requests pass through, but responses are filtered with individual-access authorization. Example policy structure: permit a principal in THVGroup::engineering to perform Action::call_tool on resources. Read-only policy checks `resource has readOnlyHint && resource.readOnlyHint == true`. Annotations come from server discovery, not client call arguments. Missing attribute access yields deny. vMCP-level MCP entity names identify the gateway, not individual backends; use resolved tool names or backend policies for backend-specific rules. No quotation.
- https://docs.stacklok.com/toolhive/guides-k8s/ — retrieved 2026-09-28; links migration track v0.15.0–v0.23.0 and v1beta1. Primary types listed: MCPServer, MCPRemoteProxy, MCPServerEntry, VirtualMCPServer. Operator manages deployment/proxy/lifecycle; full CRD catalog linked. No quotation.

### Inferences
- ToolHive directly supports both filtered discovery and invocation authorization, matching the proposed governed hub requirement; assess policy administration and domain semantics rather than assuming this infrastructure must be built afresh.

### Kubernetes CRDs and remote proxy — Observed facts

- Source: https://docs.stacklok.com/toolhive/reference/crds/ — retrieved 2026-09-28; no publication date shown. Core CRDs: MCPServer, MCPRemoteProxy, MCPServerEntry, VirtualMCPServer, and deprecated MCPRegistry. Shared CRDs: MCPGroup, MCPOIDCConfig, MCPExternalAuthConfig, MCPTelemetryConfig, MCPToolConfig, VirtualMCPCompositeToolDefinition, EmbeddingServer, MCPWebhookConfig, MCPAuthzConfig.
- Source: https://docs.stacklok.com/toolhive/guides-k8s/remote-mcp-proxy — retrieved 2026-09-28; examples use toolhive.stacklok.dev/v1beta1; no publication date shown. The operator proxies external servers supporting SSE or Streamable HTTP, adding token validation, policy enforcement, observability and audit logging. MCPToolConfig filters/renames tools. Token exchange can obtain remote credentials. Without any authentication source configured, reachable requests are accepted under a synthetic local-user identity. Private remote addresses require opt-in; loopback/metadata addresses remain blocked.

### Inferences

- ToolHive is a substantial implementation reference for Toolbox, especially separating incoming user identity, per-backend outgoing credentials, discovery filtering, and invocation authorization. Authentication must be explicitly configured for remote proxies.

### Could not verify

- The vMCP overview did not label the whole feature GA or beta. A v1beta1 Kubernetes API version alone is not evidence of product release status.

## 5. Microsoft

### Observed facts

- Source: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent — retrieved 2026-09-28; last updated 2026-05-28. Copilot Studio supports Streamable transport; SSE is unsupported after August 2025. Authentication options are none, API key (header/query), and OAuth 2.0. OAuth supports dynamic discovery/DCR, DCR with manually supplied endpoints, and manual client ID/secret/endpoints/scopes. Individual users can authorize the agent. Power Platform connector data policies also regulate MCP servers and their tools.
- Source: https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id — retrieved 2026-09-28; last updated 2026-06-24. Entra Agent ID provides identity, authorization and governance for nonhuman agents. Agent identity blueprints template individual identities; the platform supports OAuth 2.0, MCP and A2A, including agents outside Microsoft. The overview describes adaptive access, risk detection, lifecycle controls and activity logging. Agent ID is available to Entra customers; extending security features to agents requires Microsoft Agent 365 according to this page.

### Inferences

- Implement Streamable HTTP as the shared integration baseline. Keep agent identity distinct from the delegated human identity and evaluate both in Toolbox policies.

### Could not verify

- These two overview/setup pages do not establish a universal Copilot per-tool admin switch or detailed Entra token exchange semantics. No claim about them is made here.

## 6. Executor

### Observed facts

- Source: https://executor.sh/ — retrieved 2026-09-28; no publication/version shown, footer 2026. The product describes itself as an MCP gateway combining MCP, OpenAPI and GraphQL integrations into a shared tool catalog. It advertises sandboxed JavaScript, host-side credentials, workspace and individual connections, and workspace-wide tool blocking. The homepage advertises Cloud free for up to three people, Team at $15/member/month, and free self-hosting; deployment forms include Cloud, desktop, CLI and Docker. These are vendor descriptions, not independent security/performance verification.
- Source: https://executor.sh/docs — retrieved 2026-09-28; no date/version shown. Documentation describes an open-source integration layer with shared authentication and per-tool policies. It links both Docker and Cloudflare self-hosting. Policies distinguish always allowed, approval required, and blocked operations.

### Inferences

- The catalog, policy, credential isolation and code execution design overlaps with Toolbox. Bespoke domain actions and durable prepare/preview/commit/receipt semantics would need separate evaluation; the homepage does not prove those semantics.

### Could not verify

- Meta-tool enumeration remains unverified as specified below. Deployment details were read in the continuation; no security claims were tested.

### Executor proxy and CLI — Observed facts

- Source: https://executor.sh/docs/mcp-proxy — retrieved 2026-09-28; no date/version shown. Every tool call passes through the gateway, which selects an integration, attaches its connection credentials and enforces allow/approval/block policy. Upstream MCP servers join the same catalog as OpenAPI and GraphQL.
- Source: https://executor.sh/docs/local/cli — retrieved 2026-09-28; requires Node.js 20+, no publication date. A durable local HTTP service exposes Streamable HTTP at http://127.0.0.1:4788/mcp. The documented CLI searches tools, calls namespaced tools, and resumes executions paused for authentication or approval with `executor resume --execution-id …`.

### Could not verify

- These current public pages do not enumerate MCP meta-tools named skills/resume or passthrough integrations/search/invoke. The CLI resume command is not evidence of an MCP tool with that name. Homepage advertises execute as the single exposed tool; this should not be silently reconciled with older repository descriptions.

### Executor pricing/deployment — Observed facts

- Source: https://executor.sh/pricing — retrieved 2026-09-28; no date/version shown. Free Cloud: $0/month, up to three members, 100,000 executions/month, unlimited integrations. Team: $15/member/month after a 14-day trial, unlimited executions. Enterprise: custom pricing, deployment support, SSO/SAML/SCIM and tool-call audit logs. One execution is one call to the Executor tool and can contain many inner tool calls; exhausted free allowance pauses calls until reset or upgrade.
- Source: https://executor.sh/docs/hosted/docker — retrieved 2026-09-28; image example uses latest, no dated release shown. A single container combines API, MCP, authentication, QuickJS execution and web UI over libSQL/SQLite; no external database or worker required. Persistent volume contains database and encryption keys. First signup becomes owner; subsequent users join by single-use invitations. Streamable HTTP endpoint is /mcp. Local/private-network access from sandboxed code defaults off.

### Inferences

- Executor pricing meters an outer execution, not each downstream call. Compare that unit carefully with Toolbox costs. Single-container deployment is an accessible reference, but public documentation alone does not establish durable transactional mutation handling.

## 3. OpenAI — supplementary page checks

### Observed facts

- Source: https://developers.openai.com/blog/15-lessons-building-chatgpt-apps — retrieved 2026-09-28; dated 2026-02-04. This Apps SDK article distinguishes model-visible tool output from widget-only data and recommends explicitly deciding what context each receives. It does not supply a numerical tool-count rule in the sections read.
- Source: https://developers.openai.com/plugins/reference — retrieved 2026-09-28; no publication date/version shown; tool schema links reference MCP 2025-06-18. Approval-gated tool inputs can be absent from widget values until user approval. The tool-descriptor annotations include readOnlyHint, destructiveHint and openWorldHint; the latter includes public-internet/open-ended access, not merely a privately scoped externally hosted workspace.

### Inferences

- An embedded mutation preview must tolerate approval-gated input delivery and should not expose sensitive tool output through unnecessary UI/model channels.

### Could not verify

- These pages do not establish a numerical ChatGPT tool limit.

### Observed facts — tool surface guidance

- Source: https://developers.openai.com/plugins/plan/tools — retrieved 2026-09-28; no date/version shown. OpenAI recommends a focused surface organized around user goals, combining coherent operations but splitting different permissions, safety risks or confirmation requirements. Read/write behavior should be separate. Contracts should specify authorization, side effects and failure behavior; annotations do not replace server-side authorization, validation or consequential-action confirmation. The page gives qualitative guidance, not a numerical tool-count cap.

### Final research status

All six requested sections were researched through real official pages in Chrome. Count: 50 distinct official content pages read (Palantir 18; Anthropic 7; OpenAI 9; ToolHive 8; Microsoft 2; Executor 6), plus one official 404. Google result pages, repeated visits, and browser error screens are excluded. Relevant portions were read; this is not a claim that every long reference was read line by line.

Outstanding verification gaps: exact Palantir Chatbot Studio action-token handoff; Claude.ai explicit elicitation/tasks support and numeric tool limit; Claude Code bare-server naming and exhaustive add flags; a numerical ChatGPT connector tool limit; universal Claude/ChatGPT per-tool admin controls across every plan; vMCP overall GA/beta status; Executor's requested skills/resume and passthrough meta-tool enumeration. Current observations and narrower confirmed controls are recorded above. No absence from a page is treated as proof that a capability is unsupported.

Failed page: https://support.claude.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers (404; replacement building guide read). No content page required login. Browser-tab control initially failed with a request-header-policy error; native Chrome computer use worked. Visible Palantir, OpenAI and Microsoft cookie banners were rejected. No files were downloaded, no sign-in was performed, and only this findings file was written.
