import { createApp as createRealApp, type AppServices } from "../app.ts";
import { noMagicLinks } from "./support.ts";

export type { App } from "../app.ts";

/** The app, with no mail to send unless a test brings its own. */
export const createApp = (
  services: Omit<AppServices, "magicLinks"> &
    Partial<Pick<AppServices, "magicLinks">>,
) => createRealApp({ magicLinks: noMagicLinks, ...services });
