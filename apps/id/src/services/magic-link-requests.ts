import {
  renderEmail,
  type Message,
  type SendResult,
  type Transport,
} from "@answerable/emails";
import type { DBAdapter } from "better-auth";
import { eq, sql } from "drizzle-orm";

import type { RefusedIdentity } from "../auth/refused-identity.ts";

import type { Auth } from "../auth.ts";
import { authenticationTransaction } from "../auth/database-adapter.ts";
import {
  issueMagicLinkToken,
  magicLinkBrowserHash,
  magicLinkIdentifier,
  magicLinkKeys,
  magicLinkTtlMinutes,
  newMagicLinkCode,
} from "../auth/magic-link.ts";
import type { Database, Executor } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { addressRequestsInLastDay } from "../db/queries/magic-link-requests.ts";
import {
  magicLinkRequests,
  organizations,
  verifications,
} from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import { errorFields } from "../http/problem.ts";
import { createBoundedQueue } from "../lib/bounded-queue.ts";
import { createId } from "../lib/id.ts";
import { logEvent } from "../lib/log.ts";
import {
  admitMagicLink,
  holderAwaitingDirectory,
  parseMagicLinkAddress,
  type MagicLinkAddress,
} from "./magic-link-admission.ts";

/**
 * Judgement, not a standard: the figures others publish differ. A person who asks again
 * within a minute already has a working email. Five an hour from one client covers a slow
 * mail gateway, and fifty a day keeps someone else's requests from filling a mailbox.
 */
export const magicLinkLimits = {
  addressClientPerMinute: 1,
  addressClientPerHour: 5,
  addressPerDay: 50,
  /**
   * For an address no user holds, which only domain mode admits. Made-up addresses at a real
   * firm hard-bounce, and Postmark pauses a server past 10%, which would stop sign-in at every
   * firm; each row also gives three guesses at a code whose hit makes a real member. The limits
   * above do not reach this, since the addresses rotate. An office shares one egress address,
   * hence 100 and not less. The person sees what any limit shows them, so a firm-wide start
   * imports first. Judgement until staging measures them.
   */
  newAddressClientPerHour: 100,
  newAddressOrganizationPerDay: 500,
};

/**
 * Five sends at a time, a quarter of the default pool at worst, and no connection held
 * through a send. Five hundred waiting is what five clear in the drain's deadline at about
 * 200 ms a send, which is judgement until staging measures Postmark.
 */
const queueLimits = { maxLength: 500, concurrency: 5 };

/**
 * What SIGTERM leaves: the chart's 30 s grace period less its 5 s preStop sleep is 25 s.
 * A send just started takes at most 21 s (10 s, 1 s before the retry, 10 s), and finishes
 * its row at once. The 3 s left are for the server, the sweep and the pool to stop.
 * magic-link-drain.test.ts reads each number from where it is set.
 */
export const magicLinkDrainDeadlineMs = 22_000;

/** One request, as `POST /login` will see it. */
export type MagicLinkRequest = {
  /** As typed: `parseMagicLinkAddress` decides whether it costs anything. */
  address: string;
  /** The value of the browser's sign-in cookie, which the code and the link are bound to. */
  browser: string;
  /** The client's address, which the per-client limits key on. */
  client: string;
  /** The signed query of the authorisation this sign-in resumes. */
  pendingQuery: string | null;
};

type Parsed = Omit<MagicLinkRequest, "address"> & { address: MagicLinkAddress };

/** A directory sign-in refused for its address, asking that mailbox for the other proof. */
export type DirectoryConnectionRequest = Omit<MagicLinkRequest, "address"> & {
  identity: RefusedIdentity;
};

type LimitName =
  | "address_client_minute"
  | "address_client_hour"
  | "address_day"
  | "new_address_client_hour"
  | "new_address_organization_day";

const unsent: Extract<SendResult, { status: "failed" }> = {
  status: "failed",
  httpStatus: null,
  errorCode: null,
  retried: false,
};

/** What the limits count for one address: what did not fail. An address holds few rows, since
 * these limits themselves bound them. */
export const addressRequestCounts = (email: string, clientHash: string) => sql`
  select
    count(*) filter (where client_hash = ${clientHash} and created_at > statement_timestamp() - interval '60 seconds')::int as minute,
    count(*) filter (where client_hash = ${clientHash} and created_at > statement_timestamp() - interval '1 hour')::int as hour,
    count(*)::int as day
  from ${magicLinkRequests}
  where ${addressRequestsInLastDay(email)}`;

/** What one client has asked for addresses nobody holds, at any firm. It stops at the budget. */
export const newAddressClientCount = (clientHash: string) => sql`
  select count(*)::int as hour from (
    select 1 from ${magicLinkRequests}
    where client_hash = ${clientHash} and new_address and send_status <> 'failed' and created_at > statement_timestamp() - interval '1 hour'
    limit ${magicLinkLimits.newAddressClientPerHour}
  ) as recent`;

/** What one firm has been asked for addresses nobody holds. It stops at the budget. */
export const newAddressOrganizationCount = (organizationId: string) => sql`
  select count(*)::int as day from (
    select 1 from ${magicLinkRequests}
    where organization_id = ${organizationId} and new_address and send_status <> 'failed' and created_at > statement_timestamp() - interval '1 day'
    limit ${magicLinkLimits.newAddressOrganizationPerDay}
  ) as recent`;

/** The first limit this request would go over. A person a firm lists, or a user with no
 * membership there yet, is never held back by a flood of addresses nobody holds. */
async function exceededLimit(
  tx: Executor,
  email: string,
  clientHash: string,
  organizationId: string,
  newAddress: boolean,
): Promise<LimitName | undefined> {
  const {
    rows: [address],
  } = await tx.execute<{ minute: number; hour: number; day: number }>(
    addressRequestCounts(email, clientHash),
  );
  if (address!.minute >= magicLinkLimits.addressClientPerMinute)
    return "address_client_minute";
  if (address!.hour >= magicLinkLimits.addressClientPerHour)
    return "address_client_hour";
  if (address!.day >= magicLinkLimits.addressPerDay) return "address_day";
  if (!newAddress) return undefined;
  const {
    rows: [client],
  } = await tx.execute<{ hour: number }>(newAddressClientCount(clientHash));
  if (client!.hour >= magicLinkLimits.newAddressClientPerHour)
    return "new_address_client_hour";
  const {
    rows: [firm],
  } = await tx.execute<{ day: number }>(
    newAddressOrganizationCount(organizationId),
  );
  if (firm!.day >= magicLinkLimits.newAddressOrganizationPerDay)
    return "new_address_organization_day";
  return undefined;
}

/** Serialises the limit check and the insert for one address, across replicas. The
 * transaction's end releases it, and no transaction stays open across a send. */
export function lockMagicLinkAddress(tx: Executor, email: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`answerable:magic-link:${email}`}, 0))`,
  );
}

export type MagicLinkRequests = ReturnType<typeof createMagicLinkRequests>;

/**
 * Turn one request into an email, or into nothing.
 *
 * In one transaction, which the send stays out of: admission, the address's lock, the
 * limits, the token and the row. The row can sign in from then on, unless its send fails: a
 * failed send becomes `failed`, loses its token and counts against no limit.
 */
export function createMagicLinkRequests({
  auth,
  db,
  environment,
  transport,
  queue: limits = queueLimits,
}: {
  auth: Pick<Auth, "api" | "$context">;
  db: Database;
  environment: Pick<
    Environment,
    "betterAuthUrl" | "betterAuthSecret" | "betterAuthSecrets"
  >;
  transport: Transport;
  queue?: typeof queueLimits;
}) {
  const keys = magicLinkKeys(environment);

  async function reserve(
    tx: Executor,
    requestId: string,
    { address, browser, client, pendingQuery }: Parsed,
  ) {
    const admission = await admitMagicLink(tx, address);
    // Someone whose access ended asks as anyone else does, with the same page and no mail. An
    // old link or code still tells them, at confirmation.
    if (admission.outcome !== "admit") return { outcome: "stranger" } as const;
    const { organizationId, providerId, providerRevision, firmName } =
      admission;
    const { email } = address;
    await lockMagicLinkAddress(tx, email);
    const clientHash = keys.clientHash(client);
    const newAddress = admission.person.kind === "new";
    const limit = await exceededLimit(
      tx,
      email,
      clientHash,
      organizationId,
      newAddress,
    );
    if (limit) return { outcome: "limited", limit, organizationId } as const;
    const token = await issueMagicLinkToken(auth, email);
    const code = newMagicLinkCode();
    const url = new URL("/magic-link", environment.betterAuthUrl);
    url.searchParams.set("token", token);
    const rendered = renderEmail({
      template: "magic-link",
      firmName,
      url: url.toString(),
      code,
      expiresInMinutes: magicLinkTtlMinutes,
    });
    const tokenIdentifier = magicLinkIdentifier(token);
    await tx.insert(magicLinkRequests).values({
      id: requestId,
      organizationId,
      providerId,
      providerRevision,
      purpose: "link",
      email,
      tokenIdentifier,
      browserHash: magicLinkBrowserHash(browser),
      clientHash,
      codeHmac: keys.codeHmac(requestId, code),
      newAddress,
      pendingOauthQuery: pendingQuery,
      expiresAt: sql`statement_timestamp() + make_interval(mins => ${magicLinkTtlMinutes})`,
    });
    return {
      outcome: "reserved",
      organizationId,
      purpose: "link",
      tokenIdentifier,
      message: { to: email, ...rendered } satisfies Message,
    } as const;
  }

  /** The other proof of a directory: no token, and what was verified of the sign-in. */
  async function reserveConnection(
    tx: Executor,
    requestId: string,
    { identity, browser, client, pendingQuery }: DirectoryConnectionRequest,
  ) {
    const { email, organizationId, providerId, providerRevision } = identity;
    await lockMagicLinkAddress(tx, email);
    if (!(await holderAwaitingDirectory(tx, organizationId, email)))
      return { outcome: "conflict" } as const;
    const clientHash = keys.clientHash(client);
    const limit = await exceededLimit(
      tx,
      email,
      clientHash,
      organizationId,
      false,
    );
    if (limit) return { outcome: "limited", limit, organizationId } as const;
    const [firm] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const code = newMagicLinkCode();
    const rendered = renderEmail({
      template: "mailbox-code",
      firmName: firm!.name,
      code,
      expiresInMinutes: magicLinkTtlMinutes,
    });
    await tx.insert(magicLinkRequests).values({
      id: requestId,
      organizationId,
      providerId,
      providerRevision,
      purpose: "connect_directory",
      email,
      clientHash,
      browserHash: magicLinkBrowserHash(browser),
      codeHmac: keys.codeHmac(requestId, code),
      pendingOauthQuery: pendingQuery,
      directoryIssuer: identity.issuer,
      directorySubject: identity.subject,
      directoryUserId: identity.directoryUserId,
      expiresAt: sql`statement_timestamp() + make_interval(mins => ${magicLinkTtlMinutes})`,
    });
    return {
      outcome: "reserved",
      organizationId,
      purpose: "connect_directory",
      tokenIdentifier: null,
      message: { to: email, ...rendered } satisfies Message,
    } as const;
  }

  /** A failed send's answer. A link loses its token with the same commit. */
  function recordFailure(
    requestId: string,
    tokenIdentifier: string | null,
    { errorCode, httpStatus }: typeof unsent,
  ) {
    return withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
      await tx
        .update(magicLinkRequests)
        .set({
          sendStatus: "failed",
          postmarkErrorCode: errorCode,
          postmarkHttpStatus: httpStatus,
        })
        .where(eq(magicLinkRequests.id, requestId));
      if (tokenIdentifier)
        await tx
          .delete(verifications)
          .where(eq(verifications.identifier, tokenIdentifier));
    });
  }

  /** One line per request: the organisation, the row and what happened. Never the address,
   * the token, the code, the link or a hash of any of them. */
  const log = (fields: Record<string, unknown>) =>
    console.log(
      "[id] magic link",
      JSON.stringify({ event: "magic_link_request", ...fields }),
    );

  async function run(request: Parsed) {
    const requestId = createId();
    const { adapter } = await auth.$context;
    const reservation = await authenticationTransaction(
      adapter as DBAdapter,
      (_, tx) => reserve(tx, requestId, request),
    );
    if (reservation.outcome === "stranger") {
      log({ outcome: "stranger" });
      return { outcome: "stranger" } as const;
    }
    const { organizationId } = reservation;
    if (reservation.outcome === "limited") {
      log({
        outcome: "limited",
        limit: reservation.limit,
        requestId,
        organizationId,
      });
      return { outcome: "limited", limit: reservation.limit } as const;
    }
    return deliver(requestId, reservation);
  }

  /** The send, outside any transaction, and its answer. */
  async function deliver(
    requestId: string,
    {
      organizationId,
      purpose,
      tokenIdentifier,
      message,
    }: {
      organizationId: string;
      purpose: (typeof magicLinkRequests.$inferSelect)["purpose"];
      tokenIdentifier: string | null;
      message: Message;
    },
  ) {
    // A transport that throws is a failed send.
    const result = await transport.send(message).catch(() => unsent);
    if (result.status === "failed") {
      await recordFailure(requestId, tokenIdentifier, result);
      const { errorCode, httpStatus, retried } = result;
      logEvent("magic link", "magic_link_send_failed", {
        requestId,
        organizationId,
        purpose,
        errorCode,
        httpStatus,
        retried,
      });
      return { outcome: "failed", requestId, purpose } as const;
    }
    log({ outcome: "sent", requestId, organizationId, purpose });
    return { outcome: "sent", requestId, purpose } as const;
  }

  const queue = createBoundedQueue<() => Promise<unknown>>({
    ...limits,
    run: (job) => job(),
    onError: (error) =>
      logEvent("magic link", "magic_link_job_failed", errorFields(error)),
    onOverflow: (dropped) =>
      logEvent("magic link", "magic_link_queue_overflow", { dropped }),
  });

  /** The one parser decides whether a request costs anything. */
  async function handle({ address, ...rest }: MagicLinkRequest) {
    const parsed = parseMagicLinkAddress(address);
    return parsed
      ? run({ address: parsed, ...rest })
      : ({ outcome: "invalid" } as const);
  }

  return {
    /**
     * Queue one request and answer at once, whatever becomes of it, so a response cannot
     * depend on the address. False when the queue is full, which depends on no address.
     */
    request(request: MagicLinkRequest) {
      return queue.enqueue(() => handle(request));
    },
    /**
     * Ask a mailbox for the code that connects a directory. The row commits before this
     * answers, because the page that follows looks for it, and the send goes through the same
     * queue. `conflict` is an address no code can help, `limited` sends nothing new: the
     * browser may hold an earlier request's code.
     */
    async connectDirectory(request: DirectoryConnectionRequest) {
      const requestId = createId();
      const { adapter } = await auth.$context;
      const reservation = await authenticationTransaction(
        adapter as DBAdapter,
        (_, tx) => reserveConnection(tx, requestId, request),
      );
      if (reservation.outcome === "conflict") return "conflict" as const;
      if (reservation.outcome === "limited") {
        log({
          outcome: "limited",
          limit: reservation.limit,
          requestId,
          organizationId: reservation.organizationId,
        });
        return "limited" as const;
      }
      // A send that will never run must not hold a limit or look as if it might.
      if (!queue.enqueue(() => deliver(requestId, reservation)))
        await recordFailure(requestId, null, unsent);
      return "reserved" as const;
    },
    /** One request now, for what must wait for its outcome. */
    process: handle,
    /** Finish what is queued, then the database can close. */
    async drain(deadlineMs = magicLinkDrainDeadlineMs) {
      const left = await queue.drain(deadlineMs);
      if (left.abandoned > 0 || left.running > 0)
        logEvent("magic link", "magic_link_queue_abandoned", left);
      return left;
    },
  };
}
