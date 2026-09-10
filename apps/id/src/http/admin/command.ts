import { withOrganizationCommandSlot } from "./command-admission.ts";
import {
  authorizePlatformUsersCommand,
  authorizePlatformWriteCommand,
  type PlatformWriteContext,
  type PlatformUsersContext,
} from "../../services/platform-context.ts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Executor } from "../../db/client.ts";
import { actorFromContext, type Actor } from "../../services/actor.ts";
import {
  authorizeTenantMemberCommand,
  type TenantMemberContext,
} from "../../services/tenant-context.ts";
import {
  createOperationCipher,
  type OperationJson,
} from "../../services/operation-cipher.ts";
import { executeOperation } from "../../services/operations.ts";
import type { AppEnvironment } from "../context.ts";
import { ProblemError } from "../problem.ts";

export const idempotencyParameter = {
  in: "header" as const,
  name: "Idempotency-Key",
  required: true,
  schema: { type: "string" as const, minLength: 1, maxLength: 256 },
  description:
    "Stable key for this logical command. Reuse it with identical input after a lost response. Journalled commands with an organizationId path parameter admit at most two outstanding commands per target organisation per runtime database pool after route authentication. Excess commands return 503 database_busy with Retry-After: 1 before journal checkout; retry the same key and input. This is not a deployment-wide quota or an authentication/checkout bound.",
};

export const commandResponseHeaders = {
  "Operation-Id": {
    description: "Immutable logical operation ID",
    schema: { type: "string" as const, format: "uuid" },
  },
  "Idempotency-Replayed": {
    description: "Whether this response was recovered from the journal",
    schema: { type: "string" as const, enum: ["true", "false"] },
  },
};

/** HTTP JSON representation is also the encrypted replay representation. */
export const operationJson = (value: unknown): OperationJson =>
  JSON.parse(JSON.stringify(value));

type CommandResult = {
  body: unknown;
  outcome?: "applied" | "noop";
  statusCode?: number;
  resultReference: { type: string; id: string };
};
type CommandOptions = {
  retention?: "secret" | "ordinary";
  etag?: (body: OperationJson) => string;
};

async function httpCommand<T>(
  context: Context<AppEnvironment>,
  name: string,
  input: OperationJson,
  statusCode: number,
  authority: {
    scope: string;
    authorize: (tx: Executor) => Promise<T>;
    release?: (authority: T) => void;
  },
  mutate: (tx: Executor, actor: Actor, authority: T) => Promise<CommandResult>,
  options: CommandOptions,
) {
  const key = context.req.header("Idempotency-Key");
  if (!key || key.length > 256)
    throw new ProblemError(
      400,
      "invalid_idempotency_key",
      "A 1–256 character Idempotency-Key is required",
    );
  const environment = context.get("environment");
  const replayConfiguration = environment.operationReplay;
  if (!replayConfiguration)
    throw new ProblemError(
      503,
      "operation_replay_unavailable",
      "Replay encryption is not configured",
      undefined,
      { retryable: true },
    );
  const actor = actorFromContext(context);
  const result = await withOrganizationCommandSlot(
    context.get("db"),
    context.req.param("organizationId"),
    () =>
      executeOperation(
        context.get("db"),
        {
          actorInstance: `${actor.actorType}:${actor.actorId}`,
          authorityScope: authority.scope,
          name,
          key,
          input,
        },
        authority.authorize,
        async (tx, operationId, authorized) => {
          const result = await mutate(
            tx,
            { ...actor, operationId },
            authorized,
          );
          return {
            outcome: result.outcome ?? "applied",
            statusCode: result.statusCode ?? statusCode,
            resultReference: result.resultReference,
            body: operationJson(result.body),
          };
        },
        {
          cipher: createOperationCipher(replayConfiguration),
          retention: options.retention ?? "secret",
        },
        authority.release,
      ),
  );
  if (options.etag) context.header("ETag", options.etag(result.body!));
  context.header("Operation-Id", result.operation.id);
  context.header("Idempotency-Replayed", String(result.replayed));
  context.header("Cache-Control", "no-store");
  if (result.operation.statusCode === 204) return context.body(null, 204);
  return context.body(
    JSON.stringify(result.body),
    result.operation.statusCode as ContentfulStatusCode,
    { "Content-Type": "application/json" },
  );
}

export function platformCommand(
  context: Context<AppEnvironment>,
  name: string,
  input: OperationJson,
  statusCode: number,
  mutate: (platform: PlatformWriteContext) => Promise<CommandResult>,
  options: CommandOptions = {},
) {
  return httpCommand(
    context,
    name,
    input,
    statusCode,
    {
      scope: "platform",
      authorize: (tx) =>
        authorizePlatformWriteCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        }),
      release: (authorized) => authorized.close(),
    },
    (_tx, actor, authorized) => authorized.run(mutate, actor),
    options,
  );
}

export function platformUsersCommand(
  context: Context<AppEnvironment>,
  name: string,
  input: OperationJson,
  statusCode: number,
  mutate: (context: PlatformUsersContext) => Promise<CommandResult>,
  options: CommandOptions = {},
) {
  return httpCommand(
    context,
    name,
    input,
    statusCode,
    {
      scope: "platform",
      authorize: (tx) =>
        authorizePlatformUsersCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        }),
      release: (authorized) => authorized.close(),
    },
    (_tx, actor, authorized) => authorized.run(mutate, actor),
    options,
  );
}

export function tenantMemberCommand(
  context: Context<AppEnvironment>,
  name: string,
  organizationId: string,
  input: OperationJson,
  statusCode: number,
  mutate: (tenant: TenantMemberContext) => Promise<CommandResult>,
) {
  return httpCommand(
    context,
    name,
    { organizationId, input },
    statusCode,
    {
      scope: `tenant:${organizationId}`,
      authorize: (tx) =>
        authorizeTenantMemberCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
          organizationId,
        }),
      release: (authorized) => authorized.close(),
    },
    (_tx, actor, tenant) => tenant.run(mutate, actor),
    { retention: "ordinary" },
  );
}
