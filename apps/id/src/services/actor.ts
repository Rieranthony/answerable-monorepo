import type { Principal } from "../http/principal.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import type { Context } from "hono";
import type { AppEnvironment } from "../http/context.ts";

export type Actor = {
  operationId?: string;
  actorType: "user" | "client" | "system";
  actorId: string;
  requestId: string;
  ip?: string;
  userAgent?: string;
};

export type ActorMetadata = Pick<
  Actor,
  "requestId" | "operationId" | "ip" | "userAgent"
>;

export function actorIdentity(
  principal: Principal,
): Pick<Actor, "actorType" | "actorId"> {
  return {
    actorType: principal.type === "root" ? "system" : principal.type,
    actorId:
      principal.type === "root"
        ? "root"
        : principal.type === "user"
          ? principal.userId
          : principal.clientId,
  };
}

export function actorFromContext(context: Context<AppEnvironment>): Actor {
  return {
    ...actorIdentity(context.get("principal")!),
    requestId: context.get("requestId"),
    ip: context.get("clientIp") ?? undefined,
    userAgent: boundedUserAgent(context.req.header("user-agent")) ?? undefined,
  };
}

export function commandActor(
  identity: Pick<Actor, "actorType" | "actorId">,
  metadata: ActorMetadata,
): Readonly<Actor> {
  return Object.freeze({
    actorType: identity.actorType,
    actorId: identity.actorId,
    requestId: metadata.requestId,
    operationId: metadata.operationId,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
  });
}
