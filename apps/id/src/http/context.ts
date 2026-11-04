import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";

import type { Environment } from "../env.ts";
import type { TxtResolver } from "../services/domain-verification.ts";
import type { MagicLinkRequests } from "../services/magic-link-requests.ts";
import type { Principal, BearerClaims } from "./principal.ts";

export type AppEnvironment = {
  Variables: {
    auth: Auth;
    db: Database;
    requestId: string;
    clientIp: string | null;
    environment: Environment;
    magicLinks: Pick<MagicLinkRequests, "request" | "connectDirectory">;
    txtResolver: TxtResolver;
    principal?: Principal;
    bearerClaims?: BearerClaims;
    operationId?: string;
    freshAuthentication?: boolean | { unlessOnly: readonly string[] };
  };
};
