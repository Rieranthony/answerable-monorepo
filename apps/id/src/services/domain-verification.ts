import { Resolver } from "node:dns/promises";

import { logEvent } from "../lib/log.ts";

/** How DNS is asked. The shape is `node:dns/promises`': each record, as its strings. */
export type TxtResolver = (name: string) => Promise<string[][]>;

/** How long a lookup may take. Nothing holds a connection through it, but a person waits. */
export const domainLookupTimeoutMs = 5_000;

/** What a firm publishes to prove a domain. The token is no secret: DNS is public. */
export const domainVerificationRecord = ({
  domain,
  verificationToken,
}: {
  domain: string;
  verificationToken: string;
}) => ({
  type: "TXT" as const,
  name: `_answerable-challenge.${domain}`,
  value: `answerable-domain-verification=${verificationToken}`,
});

/** The system's resolver, tried once, so that its own timeout is the bound as well. */
export const systemTxtResolver: TxtResolver = (name) =>
  new Resolver({ timeout: domainLookupTimeoutMs, tries: 1 }).resolveTxt(name);

const noSuchRecord = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * What DNS holds at this name right now, or nothing, whatever went wrong: a domain with no
 * record, a resolver that failed and a timeout are all a domain not proved, and which it was
 * reaches the logs and no answer. Call it outside any transaction.
 */
export async function lookupTxtRecords(
  resolve: TxtResolver,
  name: string,
  timeoutMs = domainLookupTimeoutMs,
): Promise<string[][]> {
  let timer: Timer | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(), { code: "ETIMEOUT" })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([resolve(name), expired]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (!noSuchRecord.has(String(code)))
      logEvent("domains", "domain_lookup_failed", {
        code: typeof code === "string" ? code : null,
      });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether any one record is exactly this value. DNS splits a long value into strings, which
 * Node hands over as one record's array. Bun 1.3.1 hands each string over as a record of its
 * own (measured against a local DNS server), so strings next to each other count as one value
 * too. Whoever writes these records already controls the domain, so this widens nothing.
 */
export function txtRecordsHold(records: string[][], value: string) {
  const values = records.map((strings) => strings.join(""));
  return values.some((_, start) => {
    let joined = "";
    for (const next of values.slice(start)) {
      joined += next;
      if (joined === value) return true;
    }
    return false;
  });
}
