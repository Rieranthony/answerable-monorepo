import {
  authorizePlatformMutation,
  type PlatformMutationContext,
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
import { revisionSchema, revisionTag } from "./revision.ts";
import { freshAuthenticationGuard } from "../../auth/fresh-authentication.ts";

/** A value's HTTP JSON representation: dates become strings, undefined fields go. */
const operationJson = (value: unknown): OperationJson =>
  JSON.parse(JSON.stringify(value));

type CommandResult = {
  body: unknown;
  /** False records a noop; absent or true, an applied command. */
  changed?: boolean;
  statusCode?: number;
  resultReference: { type: string; id: string };
};
type CommandOptions = {
  /** Send the first response's id and revision as its ETag. */
  etag?: true;
};

async function httpCommand<T>(
  context: Context<AppEnvironment>,
  input: unknown,
  statusCode: number,
  authority: {
    scope: string;
    authorize: (tx: Executor) => Promise<T>;
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
      // The route's operationId names the command in the journal.
      name: context.get("operationId")!,
      key,
      input: operationJson(input),
    },
    async (tx) => {
      const authorized = await authority.authorize(tx);
      const principal = context.get("principal")!;
      // Checked before the receipt lookup, so a stale replay is refused too.
      if (needsFreshness && principal.type === "user")
        checkFreshness = await freshAuthenticationGuard(
          tx,
          principal.sessionId,
        );
      return authorized;
    },
    async (tx, operationId, authorized) => {
      const result = await mutate(tx, { ...actor, operationId }, authorized);
      // Target-row/audit waits can outlast the freshness window. Roll back
      // the whole command and its effects if time elapsed in the body.
      await checkFreshness?.();
      return {
        outcome: result.changed === false ? "noop" : "applied",
        statusCode: result.statusCode ?? statusCode,
        resultReference: result.resultReference,
        body: operationJson(result.body),
      };
    },
  );
  if (options.etag && !result.replayed)
    context.header("ETag", revisionTag(revisionSchema.parse(result.body)));
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

export function platformCommand<Access extends "users" | "write">(
  context: Context<AppEnvironment>,
  access: Access,
  input: unknown,
  statusCode: number,
  mutate: (platform: PlatformMutationContext<Access>) => Promise<CommandResult>,
  options: CommandOptions = {},
) {
  return httpCommand(
    context,
    input,
    statusCode,
    {
      scope: "platform",
      authorize: (tx) =>
        authorizePlatformMutation(
          tx,
          {
            principal: context.get("principal")!,
            environment: context.get("environment"),
            claims: context.get("bearerClaims"),
          },
          access,
        ),
    },
    (_tx, actor, authorized) => authorized.run(mutate, actor),
    options,
  );
}

export function tenantMemberCommand(
  context: Context<AppEnvironment>,
  organizationId: string,
  input: unknown,
  statusCode: number,
  mutate: (tenant: TenantMemberContext) => Promise<CommandResult>,
) {
  return httpCommand(
    context,
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
    },
    (_tx, actor, tenant) => tenant.run(mutate, actor),
    {},
  );
}
