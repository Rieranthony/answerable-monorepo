import { createHash, createHmac, hkdfSync, randomInt } from "node:crypto";
import { magicLink } from "better-auth/plugins/magic-link";

import type { Auth } from "../auth.ts";
import type { Environment } from "../env.ts";

/** How long a link and its code work: NIST 800-63B-4's cap on an out-of-band secret. */
export const magicLinkTtlMinutes = 10;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

/**
 * The row of `verifications` a token names. The plugin writes `magic-link:<stored token>`
 * and keeps that function to itself, so ID's hasher below and this are one rule. A token
 * holds 182 random bits, and the database holds only this.
 */
export const magicLinkIdentifier = (token: string) =>
  `magic-link:${hash(token)}`;

/** The browser's sign-in cookie as `magic_link_requests.browser_hash` holds it. */
export const magicLinkBrowserHash = hash;

/**
 * Better Auth's plugin, for its token and its hashed storage. ID issues through
 * `auth.api.signInMagicLink` and mails the token itself. `disableSignUp` because the
 * plugin's own user has no `status`; ID's native routes stay off the allowlist, since
 * its `verify` consumes a token on a plain GET.
 */
export function magicLinkPlugin() {
  return magicLink({
    disableSignUp: true,
    expiresIn: magicLinkTtlMinutes * 60,
    storeToken: { type: "custom-hasher", hash: async (token) => hash(token) },
    sendMagicLink: ({ token, metadata }) => metadata!.receive(token),
  });
}

/**
 * Store a new token for this address and return it, for the caller to mail. Inside a
 * Better Auth transaction, the row joins it.
 */
export async function issueMagicLinkToken(
  auth: Pick<Auth, "api">,
  email: string,
) {
  let issued: string | undefined;
  await auth.api.signInMagicLink({
    body: {
      email,
      metadata: {
        receive(token: string) {
          issued = token;
        },
      },
    },
    // requireHeaders refuses a call without any; no address is read from them.
    headers: new Headers(),
  });
  return issued!;
}

/** Eight digits, each value equally likely: `randomInt` rejects what would bias it. */
export const newMagicLinkCode = () =>
  String(randomInt(100_000_000)).padStart(8, "0");

/**
 * The keyed hashes of a request, under keys derived from the application secret that
 * writes (its ring's first), each with a label of its own. A database read reveals
 * neither a code, which eight digits would give up to a plain hash at once, nor a client
 * address.
 */
export function magicLinkKeys({
  betterAuthSecret,
  betterAuthSecrets,
}: Pick<Environment, "betterAuthSecret" | "betterAuthSecrets">) {
  const secret = betterAuthSecrets?.[0]?.value ?? betterAuthSecret;
  const key = (label: string) =>
    Buffer.from(hkdfSync("sha256", secret, "", label, 32));
  const code = key("answerable:magic-link:code:v1");
  const client = key("answerable:magic-link:client:v1");
  const mac = (of: Buffer, value: string) =>
    createHmac("sha256", of).update(value).digest("base64url");
  return {
    /** Bound to the request, so one code gives two different values on two requests. */
    codeHmac: (requestId: string, value: string) =>
      mac(code, `${requestId}:${value}`),
    clientHash: (value: string) => mac(client, value),
  };
}
