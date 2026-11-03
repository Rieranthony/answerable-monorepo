import { getIP } from "@better-auth/core/utils/ip";
import {
  getCurrentAdapter,
  type BetterAuthPlugin,
  type DBTransactionAdapter,
} from "better-auth";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  setShouldSkipSessionRefresh,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, getTableColumns, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, Executor } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { lockOrganization, lockUser } from "../db/locks.ts";
import { recordAuditEvent, type AuditAction } from "../db/queries/audit.ts";
import { provisionMembership } from "../db/queries/members.ts";
import {
  accounts,
  magicLinkRequests,
  sessions,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { errorFields } from "../http/problem.ts";
import { createId } from "../lib/id.ts";
import { logEvent } from "../lib/log.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import { newUserFields } from "../services/federation.ts";
import {
  admitMagicLink,
  parseMagicLinkAddress,
  type AdmittedPerson,
} from "../services/magic-link-admission.ts";
import { lockMagicLinkAddress } from "../services/magic-link-requests.ts";
import { activeTransaction, grantTransaction } from "./database-adapter.ts";
import {
  magicLinkBrowserHash,
  magicLinkCodeAttempts,
  magicLinkIdentifier,
  magicLinkSessionLifetimeSeconds,
} from "./magic-link.ts";
import type { createSsoOriginBoundary } from "./sso-origin.ts";

type RequestRow = typeof magicLinkRequests.$inferSelect;

/** A request that can still sign someone in, whichever way. */
const liveLink = () =>
  and(
    eq(magicLinkRequests.purpose, "link"),
    eq(magicLinkRequests.sendStatus, "sent"),
    sql`${magicLinkRequests.expiresAt} > statement_timestamp()`,
    lt(magicLinkRequests.attempts, magicLinkCodeAttempts),
  );

/** The live request this browser made with this token, if any: a token alone finds nothing. */
export async function findLiveLinkRequest(
  db: Database,
  token: string,
  browser: string,
) {
  return withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
    const [row] = await tx
      .select()
      .from(magicLinkRequests)
      .where(
        and(
          eq(magicLinkRequests.tokenIdentifier, magicLinkIdentifier(token)),
          eq(magicLinkRequests.browserHash, magicLinkBrowserHash(browser)),
          liveLink(),
        ),
      );
    return row ?? null;
  });
}

/** Who was refused, for the audit row. */
export type MagicLinkClient = {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};

/**
 * What a refusal leaves, after whatever it rolled back: the row ends, so one request writes
 * one audit row however often it is posted, and the audit row names the person when there is
 * one. Reaching here took a real cookie and a real row. A refusal stays refused when its
 * evidence cannot be stored.
 */
export async function recordMagicLinkRefusal(
  db: Database,
  row: Pick<
    RequestRow,
    "id" | "email" | "organizationId" | "providerId" | "providerRevision"
  >,
  action: Extract<AuditAction, `auth.magic_link.${string}`>,
  reason: string,
  client: MagicLinkClient,
) {
  try {
    await withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
      await tx
        .update(magicLinkRequests)
        .set({
          expiresAt: sql`least(${magicLinkRequests.expiresAt}, statement_timestamp())`,
        })
        .where(eq(magicLinkRequests.id, row.id));
      const [holder] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, row.email));
      await recordAuditEvent(tx, {
        actorType: "system",
        actorId: "magic-link",
        organizationId: row.organizationId,
        action,
        targetType: holder ? "user" : "magic_link_request",
        targetId: holder?.id ?? row.id,
        outcome: "denied",
        reason,
        ...client,
        userAgent: boundedUserAgent(client.userAgent),
        data: {
          magicLinkRequestId: row.id,
          authenticationProviderId: row.providerId,
          authenticationProviderRevision: row.providerRevision,
        },
      });
    });
  } catch (error) {
    logEvent("magic link", "magic_link_audit_unavailable", errorFields(error));
  }
}

class Refusal extends Error {
  constructor(
    readonly reason:
      | "access_removed"
      | "account_conflict"
      | "ended"
      | "not_admitted"
      | "provider_changed"
      | "token_consumed",
    readonly row: RequestRow,
  ) {
    super(reason);
  }
}

/** The row's address on the same user, however many other accounts that user holds. An
 * account of this firm's own directory, even a removed one, never stands in its way. */
async function ensureAccount(
  tx: Executor,
  row: RequestRow,
  { userId, organizationId }: { userId: string; organizationId: string },
  provider: { providerId: string; issuer: string },
  requestId: string | null,
) {
  const [created] = await tx
    .insert(accounts)
    .values({
      id: createId(),
      userId,
      providerId: provider.providerId,
      issuer: provider.issuer,
      accountId: row.email,
    })
    .onConflictDoNothing({ target: [accounts.issuer, accounts.accountId] })
    .returning({ id: accounts.id });
  if (!created) {
    const [existing] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.issuer, provider.issuer),
          eq(accounts.accountId, row.email),
          eq(accounts.userId, userId),
          eq(accounts.providerId, provider.providerId),
          isNull(accounts.deletedAt),
        ),
      );
    if (!existing) throw new Refusal("account_conflict", row);
    return existing.id;
  }
  const [other] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        isNull(accounts.deletedAt),
        ne(accounts.id, created.id),
      ),
    )
    .limit(1);
  if (other)
    await recordAuditEvent(tx, {
      actorType: "user",
      actorId: userId,
      organizationId,
      action: "identity.linked",
      targetType: "account",
      targetId: created.id,
      outcome: "success",
      requestId,
      data: {
        magicLinkRequestId: row.id,
        authenticationProviderId: row.providerId,
        authenticationProviderRevision: row.providerRevision,
        upstreamAuthTime: null,
      },
    });
  return created.id;
}

/**
 * The person a domain-mode sign-in has admitted, made here if they are new to the firm or to
 * ID: the fields a directory's first sign-in writes, and its membership. Its audit row is the
 * sign-in's own, as a directory's is.
 */
async function ensurePerson(
  adapter: DBTransactionAdapter,
  tx: Executor,
  person: AdmittedPerson,
  email: string,
  organizationId: string,
) {
  if (person.kind === "member") return person.userId;
  const userId =
    person.kind === "user"
      ? person.userId
      : (
          await adapter.create<{ id: string }>({
            model: "user",
            data: newUserFields({ email }),
          })
        ).id;
  await provisionMembership(tx, organizationId, userId);
  return userId;
}

/**
 * A magic-link sign-in, in one transaction, reached only from the pages. It answers
 * `{ url }` once signed in, or `{ refused }`: `removed` for a person whose access ended, who
 * has proved their mailbox, and `invalid` for every other refusal.
 *
 * Better Auth's own verify is not used: it consumes a token on a plain GET, has no browser to
 * compare, and needs the raw token, which the code path never holds. `consumeVerificationValue`
 * takes the stored identifier and joins this transaction.
 */
export function magicLinkConfirmation(
  db: Database,
  ssoOrigin: ReturnType<typeof createSsoOriginBoundary>,
) {
  return {
    id: "answerable-magic-link-confirmation",
    hooks: {
      before: [
        {
          // A session capped below Better Auth's week looks due for a refresh on every read,
          // and each refresh sets the session cookie, which the OAuth provider's after-hook
          // takes for a new sign-in: it runs the authorisation again and replaces the
          // response (measured: continue answered the selection page, and consent no code).
          // So this origin's sessions are not refreshed at all. The session update hook in
          // sso-origin.ts is what holds the cap if one ever is.
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (!token) return;
            // Inside a caller's transaction, a second connection could wait on the first.
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            const [origin] = await (activeTransaction(adapter) ?? db)
              .select({ kind: ssoProviders.kind })
              .from(sessions)
              .innerJoin(
                ssoProviders,
                eq(ssoProviders.id, sessions.authenticationProviderId),
              )
              .where(eq(sessions.token, token))
              // The session read that follows fails the same way, and says so as it always has.
              .catch(() => []);
            if (origin?.kind === "magic_link")
              await setShouldSkipSessionRefresh(true);
          }),
        },
      ],
    },
    endpoints: {
      confirmMagicLink: createAuthEndpoint(
        "/magic-link/confirm",
        {
          method: "POST",
          requireHeaders: true,
          body: z.object({
            identifier: z.string(),
            browser: z.string(),
            /** The code path has counted its own attempt before it gets here. */
            proof: z.enum(["link", "code"]),
            /** The provider's hooks verify it and, given a new session, resume with it. */
            oauth_query: z.string().optional(),
          }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const { identifier, browser, proof } = ctx.body;
          const requestId = ctx.headers.get("x-request-id");
          let signedIn: {
            session: Awaited<
              ReturnType<typeof ctx.context.internalAdapter.createSession>
            >;
            userId: string;
          } | null;
          try {
            signedIn = await grantTransaction(
              ctx.context.adapter,
              async (adapter: DBTransactionAdapter, tx) => {
                // What is immutable on the row says which locks to take. The address comes
                // first: the issuing job holds it while its key takes a share of the firm.
                const [named] = await tx
                  .select({
                    id: magicLinkRequests.id,
                    email: magicLinkRequests.email,
                    organizationId: magicLinkRequests.organizationId,
                    providerId: magicLinkRequests.providerId,
                  })
                  .from(magicLinkRequests)
                  .where(eq(magicLinkRequests.tokenIdentifier, identifier));
                if (!named) return null;
                await lockMagicLinkAddress(tx, named.email);
                // Then the order of the SSO callback and every grant: user, organisation,
                // provider. A command that ends what this makes waits, or this reads what
                // it committed. The request row comes last, since erasing a person deletes
                // request rows under the user's lock.
                const [holder] = await tx
                  .select({ id: users.id })
                  .from(users)
                  .where(eq(users.email, named.email));
                if (holder) await lockUser(tx, holder.id, "share");
                await lockOrganization(tx, named.organizationId, "share");
                const [provider] = await tx
                  .select({
                    providerId: ssoProviders.providerId,
                    issuer: ssoProviders.issuer,
                  })
                  .from(ssoProviders)
                  .where(eq(ssoProviders.id, named.providerId))
                  .for("share");
                const [row] = await tx
                  .select({
                    ...getTableColumns(magicLinkRequests),
                    live: sql<boolean>`${magicLinkRequests.expiresAt} > statement_timestamp()`,
                  })
                  .from(magicLinkRequests)
                  .where(eq(magicLinkRequests.id, named.id))
                  .for("update");
                // Nothing here is a person's real cookie and real row, so nothing is audited.
                if (!row || row.browserHash !== magicLinkBrowserHash(browser))
                  return null;
                if (
                  row.purpose !== "link" ||
                  row.sendStatus !== "sent" ||
                  !row.live ||
                  row.attempts >
                    (proof === "code"
                      ? magicLinkCodeAttempts
                      : magicLinkCodeAttempts - 1)
                )
                  throw new Refusal("ended", row);
                const admission = await admitMagicLink(
                  tx,
                  parseMagicLinkAddress(row.email)!,
                );
                if (admission.outcome === "removed")
                  throw new Refusal("access_removed", row);
                if (admission.outcome === "stranger")
                  throw new Refusal("not_admitted", row);
                // A link issued before a firm was switched off stays dead after it is
                // switched on, and a domain that moved firms takes no link with it. A holder
                // who appeared after the lock above was taken has no lock here: ask again.
                const { person, organizationId } = admission;
                if (
                  admission.providerId !== row.providerId ||
                  admission.providerRevision !== row.providerRevision ||
                  (person.kind === "new" ? undefined : person.userId) !==
                    holder?.id
                )
                  throw new Refusal("provider_changed", row);
                // The admission above is the authority: it read the switch, the domain's
                // proof and the person under these locks, so a switch to listed, a proof
                // lost or a removal between issue and now has already refused.
                const userId = await ensurePerson(
                  adapter,
                  tx,
                  person,
                  row.email,
                  organizationId,
                );
                const accountId = await ensureAccount(
                  tx,
                  row,
                  { userId, organizationId },
                  provider!,
                  requestId,
                );
                ssoOrigin.establish(adapter, {
                  authenticationOrganizationId: row.organizationId,
                  authenticationProviderId: row.providerId,
                  authenticationProviderRevision: row.providerRevision,
                  authenticationAccountId: accountId,
                  // The column means a directory sign-in. Null keeps sensitive admin
                  // commands and POST /auth/sso/link closed.
                  upstreamAuthTime: null,
                  userId,
                  lifetimeSeconds: magicLinkSessionLifetimeSeconds,
                });
                const consumed =
                  await ctx.context.internalAdapter.consumeVerificationValue(
                    identifier,
                  );
                if (!consumed) throw new Refusal("token_consumed", row);
                const session =
                  await ctx.context.internalAdapter.createSession(userId);
                // Either proof ends both. A right code is not a wrong code, so it takes
                // back the attempt it counted, for the failure budgets.
                await tx
                  .update(magicLinkRequests)
                  .set({
                    expiresAt: sql`statement_timestamp()`,
                    ...(proof === "code"
                      ? { attempts: sql`${magicLinkRequests.attempts} - 1` }
                      : {}),
                  })
                  .where(eq(magicLinkRequests.id, row.id));
                return { session, userId };
              },
            );
          } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            await recordMagicLinkRefusal(
              db,
              error.row,
              "auth.magic_link.refused",
              error.reason,
              {
                requestId,
                ip: getIP(ctx.headers, ctx.context.options),
                userAgent: ctx.headers.get("user-agent"),
              },
            );
            return ctx.json({
              refused:
                error.reason === "access_removed"
                  ? ("removed" as const)
                  : ("invalid" as const),
            });
          }
          if (!signedIn) return ctx.json({ refused: "invalid" as const });
          const user = await ctx.context.internalAdapter.findUserById(
            signedIn.userId,
          );
          // After the commit, so a transaction that failed set no cookie. On the endpoint's
          // own headers, where the provider's after-hook looks for a new session.
          await setSessionCookie(
            ctx,
            { session: signedIn.session, user: user! },
            false,
            { maxAge: magicLinkSessionLifetimeSeconds },
          );
          return ctx.json({ url: "/login" });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
