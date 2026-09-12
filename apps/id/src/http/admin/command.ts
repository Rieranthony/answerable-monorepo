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
  executeOperation,
  type OperationJson,
} from "../../services/operations.ts";
import type { AppEnvironment } from "../context.ts";
import { ProblemError } from "../problem.ts";
import { freshAuthenticationGuard } from "../../auth/fresh-authentication.ts";

export const idempotencyParameter = {
  in: "header" as const,
  name: "Idempotency-Key",
  required: true,
  schema: { type: "string" as const, minLength: 1, maxLength: 256 },
  description:
    "Stable key for this logical command. Reuse it with identical input after a lost response.",
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

/** Normalise first-response values to their HTTP JSON representation. */
export const operationJson = (value: unknown): OperationJson =>
  JSON.parse(JSON.stringify(value));

type CommandResult = {
  body: unknown;
  outcome?: "applied" | "noop";
  statusCode?: number;
  resultReference: { type: string; id: string };
};
type CommandOptions = {
  etag?: (body: OperationJson) => string;
};

async function httpCommand<T>(
  context: Context<AppEnvironment>,
  name: string,
  input: OperationJson,
  statusCode: number,
  authority: {
    scope: string;
    authorize: (tx: Executor, freshAuthentication: boolean) => Promise<T>;
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
  const actor = actorFromContext(context);
  const freshnessPolicy = context.get("freshAuthentication");
  const needsFreshness =
    typeof freshnessPolicy === "object"
      ? Object.keys(await context.req.json()).some(
          (field) => !freshnessPolicy.unlessOnly.includes(field),
        )
      : freshnessPolicy;
  let checkFreshness: (() => Promise<void>) | undefined;
  const result = await executeOperation(
    context.get("db"),
    {
      actorInstance: `${actor.actorType}:${actor.actorId}`,
      authorityScope: authority.scope,
      name,
      key,
      input,
    },
    async (tx) => {
      const authorized = await authority.authorize(tx, Boolean(needsFreshness));
      const principal = context.get("principal")!;
      if (needsFreshness && principal.type === "user")
        checkFreshness = await freshAuthenticationGuard(
          tx,
          principal.sessionId,
        );
      return authorized;
    },
    async (tx, operationId, authorized) => {
      await checkFreshness?.();
      const result = await mutate(tx, { ...actor, operationId }, authorized);
      // Target-row/audit waits can outlast the freshness window too. Roll
      // back the whole command and its effects if time elapsed in the body.
      await checkFreshness?.();
      return {
        outcome: result.outcome ?? "applied",
        statusCode: result.statusCode ?? statusCode,
        resultReference: result.resultReference,
        body: operationJson(result.body),
      };
    },
    authority.release,
  );
  if (options.etag && !result.replayed)
    context.header("ETag", options.etag(result.body!));
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
      authorize: (tx, freshAuthentication) =>
        authorizePlatformWriteCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
          freshAuthentication,
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
      authorize: (tx, freshAuthentication) =>
        authorizePlatformUsersCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
          freshAuthentication,
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
      authorize: (tx, freshAuthentication) =>
        authorizeTenantMemberCommand(tx, {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
          organizationId,
          freshAuthentication,
        }),
      release: (authorized) => authorized.close(),
    },
    (_tx, actor, tenant) => tenant.run(mutate, actor),
    {},
  );
}
