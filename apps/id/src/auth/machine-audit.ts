import type { machineCapability } from "./machine-capability.ts";
import { decodeJwt } from "jose";
import { z } from "zod";
import { APIError, isAPIError } from "better-auth/api";
import type { Executor } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { machineIdentitySchema } from "./machine-identity.ts";

const issuedClaims = machineIdentitySchema.extend({
  client_id: z.string().min(1),
  sub: z.string().min(1),
  jti: z.string().min(1),
  aud: z.string().min(1),
  scope: z.string().min(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

/** Only accepts our just-issued JWT; decoding here is evidence extraction, not authentication. */
export async function recordMachineIssuance(
  tx: Executor,
  input: {
    token: string;
    decision: Extract<
      Awaited<ReturnType<typeof machineCapability>>,
      { allowed: true }
    >;
    requestId?: string | null;
  },
) {
  const claims = issuedClaims.parse(decodeJwt(input.token));
  const { decision } = input;
  const grantedScopes = [
    ...new Set(claims.scope.split(" ").filter(Boolean)),
  ].sort();
  if (
    claims.client_id !== decision.client.clientId ||
    claims.sub !== decision.client.clientId ||
    claims.aud !== decision.resource.identifier ||
    claims.client_instance !== decision.client.id ||
    claims.organization_id !== decision.organization.id ||
    claims.authorization_version !== decision.client.authorizationVersion ||
    claims.organization_authorization_version !==
      decision.organization.authorizationVersion ||
    grantedScopes.length !== decision.scopes.length ||
    grantedScopes.some((scope, index) => scope !== decision.scopes[index])
  )
    throw new Error(
      "Issued token does not match its authenticated policy decision",
    );
  // Persist the evaluated snapshot; do not reconstruct the decision after minting.
  try {
    await recordAuditEvent(tx, {
      actorType: "client",
      actorId: decision.client.clientId,
      organizationId: decision.organization.id,
      action: "oauth.token.issued",
      schemaVersion: 2,
      targetType: "access_token",
      targetId: claims.jti,
      outcome: "success",
      requestId: input.requestId ?? null,
      data: {
        decision,
        issuedAt: claims.iat,
        expiresAt: claims.exp,
      },
    });
  } catch {
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      {
        error: "temporarily_unavailable",
        error_description:
          "Issuance audit could not be recorded. Retry the token request.",
      },
      { "Retry-After": "1" },
    );
  }
}

const authenticatedClient = z.object({
  id: z.uuid(),
  clientId: z.string().min(1),
  organizationId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
});
const rejectionReasons = z.enum([
  "access_denied",
  "invalid_client",
  "invalid_target",
  "invalid_scope",
  "unauthorized_client",
  "invalid_request",
  "temporarily_unavailable",
]);

/** Failed authentication has no attributable client or tenant. */
export async function recordMachineRejection(
  tx: Executor,
  input: {
    client: unknown;
    stage: "authentication" | "request" | "authorization" | "issuance";
    error: unknown;
    decision: Awaited<ReturnType<typeof machineCapability>> | null;
    requestId?: string | null;
  },
) {
  const client =
    input.stage === "authentication"
      ? null
      : authenticatedClient.parse(input.client);
  const protocolError = isAPIError(input.error) ? input.error : null;
  const denied =
    protocolError !== null &&
    protocolError.statusCode >= 400 &&
    protocolError.statusCode < 500;
  const reason = rejectionReasons.safeParse(protocolError?.body?.error);
  await recordAuditEvent(tx, {
    actorType: client ? "client" : "system",
    actorId: client?.clientId ?? "oauth-client-authentication",
    organizationId: client?.organizationId ?? null,
    action: "oauth.token.rejected",
    schemaVersion: client ? 2 : 3,
    targetType: "oauth_request",
    outcome: denied ? "denied" : "failure",
    reason: reason.success
      ? reason.data
      : denied
        ? "request_rejected"
        : input.stage === "authentication"
          ? "authentication_failed"
          : "issuance_failed",
    requestId: input.requestId ?? null,
    data: {
      grantType: "client_credentials",
      stage: input.stage,
      authenticatedClient: client,
      decision: client ? input.decision : null,
    },
  });
}
