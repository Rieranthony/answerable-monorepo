import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";

import type { Environment } from "../env.ts";
import type { Principal, Tier, BearerClaims } from "./principal.ts";

export type AppEnvironment = {
  Variables: {
    auth: Auth;
    db: Database;
    ssoTest?: { allowPrivateHosts: boolean };
    requestId: string;
    environment: Environment;
    principal?: Principal;
    bearerClaims?: BearerClaims;
    tier?: Tier;
    operationId?: string;
  };
};
