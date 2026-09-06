import type { Context } from "hono";
import type { AppEnvironment } from "../http/context.ts";

export type Actor = {
  actorType: "user" | "client";
  actorId: string;
  requestId: string;
  ip?: string;
  userAgent?: string;
};

export function actorFromContext(context: Context<AppEnvironment>): Actor {
  const principal = context.get("principal")!;
  return {
    actorType: principal.type,
    actorId: principal.type === "user" ? principal.userId : principal.clientId,
    requestId: context.get("requestId"),
    ip: context.req.header("x-forwarded-for")?.split(",")[0].trim(),
    userAgent: context.req.header("user-agent"),
  };
}
