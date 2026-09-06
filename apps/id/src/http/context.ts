import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";

import type { Environment } from "../env.ts";
import type { Principal, Tier } from "./principal.ts";

export type AppEnvironment = {
  Variables: {
    auth: Auth;
    db: Database;
    requestId: string;
    environment: Environment;
    principal?: Principal;
    tier?: Tier;
    operationId?: string;
  };
};
