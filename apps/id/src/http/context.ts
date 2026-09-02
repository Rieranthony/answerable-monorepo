import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";

export type AppEnvironment = {
  Variables: {
    auth: Auth;
    db: Database;
    requestId: string;
  };
};
