import type { Hono } from "hono";
import { jsx } from "hono/jsx";

import { findOrganizationSignInRoute } from "../../../db/queries/organization-domains.ts";
import { slugPattern } from "../../../db/schema/columns.ts";
import type { AppEnvironment } from "../../context.ts";
import { describeError } from "../error-copy.ts";
import type { PageContext } from "../gateway.ts";
import { pendingOfErrorPage } from "../login-routing.ts";
import { ErrorView } from "../views/error.tsx";
import { resumableQuery } from "./login.ts";

// Anyone can write a link to this page, so only a code-shaped description is
// shown; free text would speak with the identity domain's voice.
const detailsPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Whether the firm a failed sign-in was for has links on, so that the page can offer one. The
 * name comes from the address, which anyone can write: it says no more than `POST /login` says
 * of the firm's domain, and the form it shows answers as that page does. If this read fails,
 * the page still has its way back to the address form.
 */
async function firmOffersLinks(context: PageContext, firm: string | null) {
  if (firm === null || !slugPattern.test(firm)) return false;
  const route = await findOrganizationSignInRoute(
    context.get("db"),
    firm,
  ).catch(() => null);
  return route?.magicLink === true;
}

export function registerError(app: Hono<AppEnvironment>) {
  app.get("/error", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const details = query.get("error_description");
    const pending = await resumableQuery(context, pendingOfErrorPage(query));
    return context.render(
      jsx(ErrorView, {
        description: describeError(query.get("error")),
        details:
          details !== null && detailsPattern.test(details) ? details : null,
        query: pending ?? "",
        offersLink: await firmOffersLinks(context, query.get("firm")),
      }),
      { title: "Can't sign in" },
    );
  });
}
