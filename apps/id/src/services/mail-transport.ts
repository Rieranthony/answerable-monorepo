import {
  createLogTransport,
  createPostmarkTransport,
  type Transport,
} from "@answerable/emails";

import type { Environment } from "../env.ts";

/**
 * What mail goes through. With a token, Postmark, at `POSTMARK_API_URL` when a test or the kind
 * stack set one. Without a token, a line on standard output, where printing the link is the
 * point: only outside production, where the configuration requires the token, so a production
 * process that reaches here without one is a mistake, and it must not print working links.
 */
export function createMailTransport(
  environment: Pick<
    Environment,
    "nodeEnv" | "postmarkServerToken" | "postmarkApiUrl" | "mailFromAddress"
  >,
): Transport {
  if (environment.postmarkServerToken)
    return createPostmarkTransport({
      serverToken: environment.postmarkServerToken,
      endpoint: environment.postmarkApiUrl,
      from: `Answerable ID <${environment.mailFromAddress}>`,
      replyTo: "info@answerable.org",
    });
  if (environment.nodeEnv === "production")
    throw new Error("POSTMARK_SERVER_TOKEN is required in production");
  return createLogTransport((line) => console.log(line));
}
