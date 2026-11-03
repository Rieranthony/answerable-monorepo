import {
  createLogTransport,
  createPostmarkTransport,
  type Transport,
} from "@answerable/emails";

import type { Environment } from "../env.ts";
import { logEvent } from "../lib/log.ts";

/**
 * What mail goes through. With a token, Postmark. Without one outside production, a line
 * on standard output, where printing the link is the point.
 */
export function createMailTransport(
  environment: Pick<
    Environment,
    | "nodeEnv"
    | "postmarkServerToken"
    | "mailFrom"
    | "mailReplyTo"
    | "mailSubjectPrefix"
  >,
): Transport {
  if (environment.postmarkServerToken)
    return createPostmarkTransport({
      serverToken: environment.postmarkServerToken,
      from: environment.mailFrom,
      replyTo: environment.mailReplyTo,
      subjectPrefix: environment.mailSubjectPrefix,
    });
  if (environment.nodeEnv !== "production")
    return createLogTransport((line) => console.log(line));
  // Production with no token sends nothing, and every request records a failed send. Once
  // the deployment delivers a token, the configuration requires it and this branch goes.
  logEvent("mail", "postmark_server_token_missing");
  return {
    send: async () => ({
      status: "failed",
      httpStatus: null,
      errorCode: null,
      retried: false,
    }),
  };
}
