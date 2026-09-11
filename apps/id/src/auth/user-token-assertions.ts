import {
  getIssuer,
  getOAuthProviderApi,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { z } from "zod";
import type { userResourcePolicy } from "./user-resource-policy.ts";

type Context = Parameters<typeof getOAuthProviderApi>[0];
type Decision = Extract<
  Awaited<ReturnType<typeof userResourcePolicy>>,
  { allowed: true }
>;
const responseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string(),
  token_type: z.enum(["Bearer", "DPoP"]),
  expires_at: z.number().int(),
  expires_in: z.number().int().nonnegative(),
});
const storedSchema = z.object({
  id: z.string(),
  userId: z.string(),
  clientId: z.string(),
  referenceId: z.string(),
  authorizationCodeId: z.string(),
  scopes: z.array(z.string()),
  resources: z.array(z.string()).nullish(),
  createdAt: z.date(),
  expiresAt: z.date(),
  revoked: z.date().nullish(),
  authTime: z.date().nullish(),
  refreshId: z.string().nullish(),
  confirmation: z.object({ jkt: z.string().optional() }).nullish(),
});
const invalid = () => new APIError("BAD_REQUEST", { error: "invalid_grant" });
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
function sameValues(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

/** Assert native output inside its transaction, including encrypted rotation replay.
 * These JWTs are freshly returned by the provider, not caller-supplied credentials. */
export async function assertUserTokenResponse(input: {
  ctx: Context;
  options: OAuthOptions<string[]>;
  decision: Decision;
  identity: Record<string, unknown>;
  response: unknown;
  reference: { scopes: string[]; resources: string[]; nonce?: string };
  clientAllowsRefresh: boolean;
  authorizationCodeId: string;
  replayed: boolean;
  startedAt: number;
}) {
  const { ctx, options, decision, reference } = input;
  const parsed = responseSchema.safeParse(input.response);
  if (!parsed.success) throw invalid();
  const response = parsed.data;
  const adapter = ctx.context.adapter;
  const api = getOAuthProviderApi(ctx, options);
  const requestedScopes = decision.requestedScopes!;
  const expectedScopes = requestedScopes.filter(
    (scope) =>
      decision.resource === null ||
      decision.resource.scopeCeiling!.includes(scope),
  );
  const scopes = response.scope.split(" ").filter(Boolean);
  const hasRefresh =
    input.clientAllowsRefresh &&
    (reference.scopes.includes("offline_access") ||
      requestedScopes.includes("offline_access"));
  if (
    !sameValues(scopes, expectedScopes) ||
    Boolean(response.id_token) !== scopes.includes("openid") ||
    Boolean(response.refresh_token) !== hasRefresh
  )
    throw invalid();

  const now = Math.floor(Date.now() / 1000);
  function issuedAt(iat: unknown): iat is number {
    return (
      Number.isSafeInteger(iat) &&
      (iat as number) <= now &&
      (input.replayed || (iat as number) >= input.startedAt)
    );
  }
  async function stored(token: string, kind: "access_token" | "refresh_token") {
    const hash = await api.hashToken(token, kind);
    const parsed = storedSchema.safeParse(
      await adapter.findOne({
        model:
          kind === "access_token" ? "oauthAccessToken" : "oauthRefreshToken",
        where: [{ field: "token", value: hash }],
      }),
    );
    if (!parsed.success) throw invalid();
    const row = parsed.data;
    if (
      row.userId !== decision.grant.userId ||
      row.clientId !== decision.client!.clientId ||
      row.referenceId !== decision.grant.id ||
      row.authorizationCodeId !== input.authorizationCodeId ||
      !sameValues(row.scopes, scopes) ||
      !sameValues(row.resources ?? [], reference.resources) ||
      row.revoked ||
      !issuedAt(seconds(row.createdAt))
    )
      throw invalid();
    return row;
  }
  let iat: number;
  let confirmation: { jkt?: string } | null | undefined;
  let opaque: z.infer<typeof storedSchema> | undefined;
  if (decision.resource !== null) {
    const access = decodeJwt(response.access_token);
    const audience =
      typeof access.aud === "string" ? [access.aud] : (access.aud ?? []);
    // Native adds UserInfo from the requested openid scope before resource filtering.
    const expectedAudience = [
      decision.resource.identifier,
      ...(requestedScopes.includes("openid")
        ? [`${ctx.context.baseURL}/oauth2/userinfo`]
        : []),
    ];
    if (
      decodeProtectedHeader(response.access_token).typ !== "at+jwt" ||
      access.sub !== decision.grant.userId ||
      access.iss !== getIssuer(ctx, options) ||
      access.client_id !== decision.client!.clientId ||
      access.azp !== decision.client!.clientId ||
      Object.entries(input.identity).some(
        ([key, value]) => access[key] !== value,
      ) ||
      !sameValues(audience, expectedAudience) ||
      access.scope !== response.scope ||
      !issuedAt(access.iat) ||
      access.exp !== response.expires_at
    )
      throw invalid();
    iat = access.iat;
    confirmation = access.cnf as typeof confirmation;
  } else {
    opaque = await stored(response.access_token, "access_token");
    iat = seconds(opaque.createdAt);
    if (seconds(opaque.expiresAt) !== response.expires_at) throw invalid();
    confirmation = opaque.confirmation;
  }
  if (response.token_type !== (confirmation?.jkt ? "DPoP" : "Bearer"))
    throw invalid();

  if (response.refresh_token) {
    const refresh = await stored(response.refresh_token, "refresh_token");
    if (
      seconds(refresh.createdAt) !== iat ||
      refresh.authTime?.getTime() !== decision.grant.authTime.getTime() ||
      refresh.confirmation?.jkt !== confirmation?.jkt ||
      (opaque && opaque.refreshId !== refresh.id)
    )
      throw invalid();
  } else if (opaque?.refreshId) throw invalid();
  if (response.id_token) {
    const id = decodeJwt(response.id_token);
    if (
      id.sub !== decision.grant.userId ||
      id.iss !== getIssuer(ctx, options) ||
      id.aud !== decision.client!.clientId ||
      id.auth_time !== seconds(decision.grant.authTime) ||
      id.nonce !== reference.nonce ||
      !issuedAt(id.iat) ||
      id.iat < iat ||
      id.exp !== id.iat + (options.idTokenExpiresIn ?? 36_000) ||
      Object.entries(input.identity).some(([key, value]) => id[key] !== value)
    )
      throw invalid();
  }
  return scopes;
}
