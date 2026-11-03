import {
  renderEmail,
  type Message,
  type SendResult,
  type Transport,
} from "@answerable/emails";
import type { DBAdapter } from "better-auth";
import { eq, sql } from "drizzle-orm";

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
import { magicLinkRequests, verifications } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import { errorFields } from "../http/problem.ts";
import { createBoundedQueue } from "../lib/bounded-queue.ts";
import { createId } from "../lib/id.ts";
import { logEvent } from "../lib/log.ts";
import {
  admitMagicLink,
  parseMagicLinkAddress,
  type MagicLinkAddress,
} from "./magic-link-admission.ts";

/**
 * Judgement, not a standard: the figures others publish differ. A person who asks again
 * within a minute already has a working email. Five an hour from one client covers a slow
 * mail gateway, and fifty a day keeps someone else's requests from filling a mailbox.
 * The organisation's cap stops a flood of real addresses before it costs every firm its
 * sender's reputation.
 */
export const magicLinkLimits = {
  addressClientPerMinute: 1,
  addressClientPerHour: 5,
  addressPerDay: 50,
  organizationPerHour: 5_000,
  /**
   * For an address no user holds, which only domain mode admits. Made-up addresses at a real
   * firm hard-bounce, and Postmark pauses a server past 10%, which would stop sign-in at every
   * firm; each row also gives three guesses at a code whose hit makes a real member. The limits
   * above do not reach this, since the addresses rotate: one client at the page's budget reaches
   * 5,000 in about 14 minutes. An office shares one egress address, hence 100 and not less. The
   * person sees what any limit shows them, so a firm-wide start imports first. Judgement until
   * staging measures them.
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

type LimitName =
  | "address_client_minute"
  | "address_client_hour"
  | "address_day"
  | "organization_hour"
  | "new_address_client_hour"
  | "new_address_organization_day";

const unsent: SendResult = {
  status: "failed",
  httpStatus: null,
  errorCode: null,
  retried: false,
};

/** What the limits count for one address: what did not fail, on a partial index. An
 * address holds few rows, since these limits themselves bound them. */
export const addressRequestCounts = (email: string, clientHash: string) => sql`
  select
    count(*) filter (where client_hash = ${clientHash} and created_at > statement_timestamp() - interval '60 seconds')::int as minute,
    count(*) filter (where client_hash = ${clientHash} and created_at > statement_timestamp() - interval '1 hour')::int as hour,
    count(*)::int as day
  from ${magicLinkRequests}
  where email = ${email} and send_status <> 'failed' and created_at > statement_timestamp() - interval '1 day'`;

/** What the cap counts for one firm. It stops at the cap, so a firm at its cap reads no
 * more than the cap's rows of a partial index however many it holds. */
export const organizationRequestCount = (organizationId: string) => sql`
  select count(*)::int as hour from (
    select 1 from ${magicLinkRequests}
    where organization_id = ${organizationId} and send_status <> 'failed' and created_at > statement_timestamp() - interval '1 hour'
    limit ${magicLinkLimits.organizationPerHour}
  ) as recent`;

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
  const {
    rows: [organization],
  } = await tx.execute<{ hour: number }>(
    organizationRequestCount(organizationId),
  );
  if (organization!.hour >= magicLinkLimits.organizationPerHour)
    return "organization_hour";
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
 * limits, the token, and a `sending` row. A row that never leaves `sending` signs nobody
 * in, so a paused Postmark stops guesses as well as mail. A failed send becomes `failed`,
 * loses its token and counts against no limit.
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
    if (admission.outcome === "stranger")
      return { outcome: "stranger" } as const;
    const { organizationId, providerId, providerRevision, firmName } =
      admission;
    const { email } = address;
    await lockMagicLinkAddress(tx, email);
    const clientHash = keys.clientHash(client);
    const newAddress =
      admission.outcome === "admit" && admission.person.kind === "new";
    const limit = await exceededLimit(
      tx,
      email,
      clientHash,
      organizationId,
      newAddress,
    );
    if (limit) return { outcome: "limited", limit, organizationId } as const;
    const row = {
      id: requestId,
      organizationId,
      providerId,
      providerRevision,
      email,
      clientHash,
      newAddress,
      expiresAt: sql`statement_timestamp() + make_interval(mins => ${magicLinkTtlMinutes})`,
    };
    if (admission.outcome === "removed") {
      const rendered = renderEmail({ template: "access-removed", firmName });
      await tx
        .insert(magicLinkRequests)
        .values({ ...row, purpose: "access_removed" });
      return {
        outcome: "reserved",
        organizationId,
        purpose: "access_removed",
        tokenIdentifier: null,
        message: { to: email, ...rendered } satisfies Message,
      } as const;
    }
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
      ...row,
      purpose: "link",
      tokenIdentifier,
      browserHash: magicLinkBrowserHash(browser),
      codeHmac: keys.codeHmac(requestId, code),
      pendingOauthQuery: pendingQuery,
    });
    return {
      outcome: "reserved",
      organizationId,
      purpose: "link",
      tokenIdentifier,
      message: { to: email, ...rendered } satisfies Message,
    } as const;
  }

  /** Record the send's answer. A link that failed loses its token with the same commit. */
  function finish(
    requestId: string,
    tokenIdentifier: string | null,
    result: SendResult,
  ) {
    return withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
      await tx
        .update(magicLinkRequests)
        .set(
          result.status === "sent"
            ? { sendStatus: "sent" }
            : {
                sendStatus: "failed",
                postmarkErrorCode: result.errorCode,
                postmarkHttpStatus: result.httpStatus,
              },
        )
        .where(eq(magicLinkRequests.id, requestId));
      if (result.status === "failed" && tokenIdentifier)
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
    const { purpose, tokenIdentifier, message } = reservation;
    // A transport refuses an address it cannot send to by throwing; that is a failed send.
    const result = await transport.send(message).catch(() => unsent);
    await finish(requestId, tokenIdentifier, result);
    if (result.status === "failed") {
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

  const queue = createBoundedQueue<Parsed>({
    ...limits,
    run,
    onError: (error) =>
      logEvent("magic link", "magic_link_job_failed", errorFields(error)),
    onOverflow: (dropped) =>
      logEvent("magic link", "magic_link_queue_overflow", { dropped }),
  });

  function parse({ address, ...rest }: MagicLinkRequest): Parsed | null {
    const parsed = parseMagicLinkAddress(address);
    return parsed && { address: parsed, ...rest };
  }

  return {
    /**
     * Queue one request and answer at once, whatever becomes of it, so a response cannot
     * depend on the address. False when the address is refused or the queue is full.
     */
    request(request: MagicLinkRequest) {
      const parsed = parse(request);
      return parsed !== null && queue.enqueue(parsed);
    },
    /** One request now, for what must wait for its outcome. */
    async process(request: MagicLinkRequest) {
      const parsed = parse(request);
      return parsed ? run(parsed) : ({ outcome: "invalid" } as const);
    },
    /** Finish what is queued, then the database can close. */
    async drain(deadlineMs = magicLinkDrainDeadlineMs) {
      const left = await queue.drain(deadlineMs);
      if (left.abandoned > 0 || left.running > 0)
        logEvent("magic link", "magic_link_queue_abandoned", left);
      return left;
    },
  };
}
