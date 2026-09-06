import { z } from "zod";
import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/oauth-clients.ts";
import { lockResource } from "../db/queries/oauth-resources.ts";
import { findOrganization } from "../db/queries/organizations.ts";
import { revokeClientTokens } from "../db/queries/oauth-tokens.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
import { generateClientSecret, hashClientSecret } from "./client-secrets.ts";

type ClientRow = NonNullable<Awaited<ReturnType<typeof queries.findClient>>>;
export type CreateClientInput = {
  clientId?: string;
  name: string;
  organizationId?: string;
  tokenEndpointAuthMethod: "client_secret_basic" | "private_key_jwt" | "none";
  grantTypes: ("client_credentials" | "authorization_code" | "refresh_token")[];
  redirectUris: string[];
  clientCredentialsScopes?: string[];
  scopes?: string[];
  jwks?: string;
  jwksUri?: string;
  skipConsent?: boolean;
  uri?: string;
  contacts?: string[];
};
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "Client, resource or organisation not found",
    );
  return row;
}
function publicClient({ clientSecret, ...row }: ClientRow) {
  return { ...row, hasClientSecret: clientSecret !== null };
}
function audit(
  tx: Executor,
  actor: Actor,
  clientId: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    targetType: "client",
    targetId: clientId,
    action,
    outcome: "success",
    data,
  });
}
const jwkSetSchema = z.object({
  keys: z.array(z.object({ kty: z.string().min(1) }).loose()).min(1),
});
function validateClient(
  input: Pick<
    queries.ClientInput,
    | "tokenEndpointAuthMethod"
    | "grantTypes"
    | "redirectUris"
    | "clientCredentialsScopes"
    | "organizationId"
    | "jwks"
    | "jwksUri"
  >,
) {
  const errors: { path: string; message: string }[] = [];
  const machine = input.grantTypes?.includes("client_credentials");
  if (input.tokenEndpointAuthMethod === "none" && machine)
    errors.push({
      path: "tokenEndpointAuthMethod",
      message: "Public clients cannot use client_credentials",
    });
  if (machine && !input.clientCredentialsScopes?.length)
    errors.push({
      path: "clientCredentialsScopes",
      message: "Machine clients require at least one scope",
    });
  if (machine && !input.organizationId)
    errors.push({
      path: "organizationId",
      message: "Machine clients require an owning organisation",
    });
  if (
    input.grantTypes?.includes("authorization_code") &&
    !input.redirectUris.length
  )
    errors.push({
      path: "redirectUris",
      message: "Authorization code clients require at least one redirect URI",
    });
  if (input.tokenEndpointAuthMethod === "private_key_jwt") {
    const hasJwks = input.jwks !== undefined && input.jwks !== null;
    const hasJwksUri = input.jwksUri !== undefined && input.jwksUri !== null;
    if (hasJwks === hasJwksUri)
      errors.push({
        path: "jwks",
        message: "Provide exactly one of jwks or jwksUri",
      });
    if (hasJwks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.jwks!);
      } catch {
        parsed = null;
      }
      if (!jwkSetSchema.safeParse(parsed).success)
        errors.push({
          path: "jwks",
          message: "Provide a JWK set JSON string with at least one key",
        });
    }
  }
  if (errors.length)
    throw new ProblemError(
      400,
      "validation_failed",
      "The request is invalid",
      undefined,
      { errors },
    );
}
export async function listClients(db: Database, query: queries.ClientQuery) {
  const page = cursorPage(await queries.listClients(db, query), query.limit);
  return { ...page, items: page.items.map(publicClient) };
}
export async function getClient(db: Database, clientId: string) {
  return publicClient(requireRow(await queries.findClient(db, clientId)));
}
export function createClient(
  db: Database,
  actor: Actor,
  input: CreateClientInput,
) {
  validateClient(input);
  return db.transaction(async (tx) => {
    if (input.organizationId)
      requireRow(await findOrganization(tx, input.organizationId));
    const clientId =
      input.clientId ??
      `client_${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const clientSecret =
      input.tokenEndpointAuthMethod === "client_secret_basic"
        ? generateClientSecret()
        : undefined;
    const row = await queries.createClient(tx, {
      ...input,
      clientId,
      clientSecret:
        clientSecret === undefined ? null : hashClientSecret(clientSecret),
      responseTypes: input.grantTypes.includes("authorization_code")
        ? ["code"]
        : [],
      requirePKCE: true,
    });
    await audit(tx, actor, clientId, "client.created", { ...input, clientId });
    return {
      ...publicClient(row),
      ...(clientSecret === undefined ? {} : { clientSecret }),
    };
  });
}
export function updateClient(
  db: Database,
  actor: Actor,
  clientId: string,
  patch: queries.ClientPatch,
) {
  return db.transaction(async (tx) => {
    const existing = requireRow(await queries.lockClient(tx, clientId));
    validateClient({ ...existing, ...patch });
    const row = await queries.updateClient(tx, clientId, patch);
    await audit(tx, actor, clientId, "client.updated", { changes: patch });
    return publicClient(row!);
  });
}
function setDisabled(
  db: Database,
  actor: Actor,
  clientId: string,
  disabled: boolean,
) {
  return db.transaction(async (tx) => {
    const existing = requireRow(await queries.lockClient(tx, clientId));
    if (existing.disabled === disabled)
      throw new ProblemError(
        409,
        disabled ? "client_already_disabled" : "client_already_active",
        "Client is already in the requested state",
      );
    const row = await queries.setClientDisabled(tx, clientId, disabled);
    const data = disabled
      ? await revokeClientTokens(tx, [clientId])
      : { disabled };
    await audit(
      tx,
      actor,
      clientId,
      disabled ? "client.disabled" : "client.enabled",
      data,
    );
    return publicClient(row!);
  });
}
export function disableClient(db: Database, actor: Actor, clientId: string) {
  return setDisabled(db, actor, clientId, true);
}
export function enableClient(db: Database, actor: Actor, clientId: string) {
  return setDisabled(db, actor, clientId, false);
}
export function rotateSecret(db: Database, actor: Actor, clientId: string) {
  return db.transaction(async (tx) => {
    const existing = requireRow(await queries.lockClient(tx, clientId));
    if (existing.tokenEndpointAuthMethod !== "client_secret_basic")
      throw new ProblemError(
        409,
        "client_has_no_secret",
        "Client does not use a shared secret",
      );
    const clientSecret = generateClientSecret();
    await queries.setClientSecret(tx, clientId, hashClientSecret(clientSecret));
    await audit(tx, actor, clientId, "client.secret_rotated", {});
    return { clientId, clientSecret };
  });
}
export function setOwner(
  db: Database,
  actor: Actor,
  clientId: string,
  organizationId: string | null,
) {
  return db.transaction(async (tx) => {
    const existing = requireRow(await queries.lockClient(tx, clientId));
    if (organizationId !== null)
      requireRow(await findOrganization(tx, organizationId));
    const row = await queries.assignClientOrganization(tx, {
      clientId,
      organizationId,
    });
    await audit(tx, actor, clientId, "client.owner_changed", {
      from: existing.organizationId,
      to: organizationId,
    });
    return publicClient(row);
  });
}
export function linkResource(
  db: Database,
  actor: Actor,
  clientId: string,
  resource: string,
) {
  return db.transaction(async (tx) => {
    requireRow(await queries.lockClient(tx, clientId));
    requireRow(await lockResource(tx, resource));
    const result = await queries.linkClientResource(tx, clientId, resource);
    await audit(tx, actor, clientId, "client.resource_linked", {
      resource,
      ...result,
    });
    return result;
  });
}
export function unlinkResource(
  db: Database,
  actor: Actor,
  clientId: string,
  resource: string,
) {
  return db.transaction(async (tx) => {
    requireRow(await queries.lockClient(tx, clientId));
    if (!(await queries.unlinkClientResource(tx, clientId, resource)))
      throw new ProblemError(
        404,
        "not_found",
        "Client resource link not found",
      );
    await audit(tx, actor, clientId, "client.resource_unlinked", { resource });
  });
}
