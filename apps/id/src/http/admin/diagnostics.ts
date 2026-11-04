import { tenantRead } from "./tenant-read.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  diagnoseSignIn,
  signInVerdictCodes,
  tokenOnlyCodes,
} from "../../services/diagnostics.ts";
import type { AppEnvironment } from "../context.ts";
import {
  magicLinkPurposes,
  magicLinkSendStatuses,
  userStatuses,
} from "../../db/schema/vocabulary.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";

const params = uuidParam("organizationId");
const query = z.object({ email: z.email().toLowerCase() });
const signInDiagnosisSchema = z.object({
  email: z.email(),
  routing: z.object({
    domain: z.string(),
    routesTo: z
      .object({ organizationId: z.uuid(), slug: z.string() })
      .nullable(),
    matchesThisOrganization: z.boolean(),
  }),
  organization: z.object({
    id: z.uuid(),
    slug: z.string(),
    status: z.enum(["active", "disabled"]),
  }),
  provider: z.object({
    configured: z.boolean(),
    kind: z.enum(["entra", "google", "oidc"]).nullable(),
    issuer: z.string().nullable(),
  }),
  magicLink: z.object({
    enabled: z.boolean(),
    suppressed: z.boolean(),
    lastRequest: z
      .object({
        id: z.uuid(),
        purpose: z.enum(magicLinkPurposes),
        sendStatus: z
          .enum(magicLinkSendStatuses)
          .describe(
            "sent: no failure has been recorded; delivery is in Postmark's Activity. failed: Postmark refused the send, or never answered",
          ),
        postmarkErrorCode: z.number().int().nullable(),
        postmarkHttpStatus: z.number().int().nullable(),
        createdAt: z.iso.datetime(),
      })
      .nullable(),
    directoryConnection: z
      .object({
        id: z.uuid(),
        sendStatus: z.enum(magicLinkSendStatuses),
        attempts: z.number().int(),
        expiresAt: z.iso.datetime(),
      })
      .nullable()
      .describe(
        "A directory sign-in this address has made and not yet connected: it is waiting on the code mailed to it. Null when none is live",
      ),
    requestsInLastDay: z
      .number()
      .int()
      .describe(
        "This address's sign-in mails in the last day at this firm, leaving out those that failed: what dailyLimit counts",
      ),
    dailyLimit: z
      .number()
      .int()
      .describe("How many mails an address gets in a day, from any client"),
  }),
  user: z
    .object({
      id: z.uuid(),
      status: z.enum(userStatuses),
    })
    .nullable(),
  membership: z
    .object({
      memberId: z.uuid(),
      effective: z.boolean(),
      validFrom: z.iso.datetime().nullable(),
      validUntil: z.iso.datetime().nullable(),
    })
    .nullable(),
  verdict: z.object({
    code: z.enum(signInVerdictCodes),
    checked: z.array(z.enum(signInVerdictCodes)),
    requiresToken: z.array(z.enum(tokenOnlyCodes)),
  }),
});
export const routes = {
  diagnoseSignIn: {
    method: "get",
    path: "/organizations/:organizationId/sign-in-diagnosis",
    operationId: "diagnoseSignIn",
    summary: "Diagnose sign-in by email",
    description:
      "Inspect tenant-local configuration and membership. Current platform:read or org:users authority is rechecked inside the read transaction. Routing identifies only this organisation; user and membership are null unless this tenant has a membership for the exact email. Global accounts and retired-email state are excluded, including for staff. A null user does not mean the email is globally unused. authentication_required means local checks found no blocker; a real IdP authentication or a magic link's confirmation must establish identity and account conflicts. provider describes the directory; magicLink is the organisation's setting and the newest sign-in mail for this exact email, kept for seven days. magic_link_not_listed means a link is the way in, the organisation lists its members and this address is not an effective member of it; it reads this organisation alone, so in domain mode, and for an account another firm holds, it says nothing and the other fields show the rest. magic_link_address_limit means a link is the way in and this address has had magicLink.dailyLimit mails in the last day, so it gets no more until the oldest passes a day. magic_link_suppressed means a link is the way in and Postmark refused the last send as a suppressed address (406), which staff reactivate in Postmark. A message's delivery, bounces and suppressions are in Postmark's Activity, not here. magicLink.directoryConnection is a directory sign-in this address has made and not yet connected, waiting on the code mailed to it. Windows affect grants, not admission; revoked membership requires reinstatement. Responses use no-store. validation_failed rejects malformed input; not_found means the organisation is unavailable.",
    tag: "Diagnostics",
    platformScope: "platform:read",
    orgScope: "org:users",
    kind: "read",
    parameters: [
      pathParameter("organizationId", "uuid"),
      {
        in: "query",
        name: "email",
        required: true,
        schema: { type: "string", format: "email" },
      },
    ],
    example: { query: { email: "person@example.com" } },
    responses: {
      200: {
        description: "Sign-in diagnosis",
        content: json(signInDiagnosisSchema),
      },
      ...problemResponses(400, 404),
    },
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.diagnoseSignIn,
    validate("param", params),
    validate("query", query),
    async (context) =>
      context.json(
        await tenantRead(context, "memberAccess", (tenant) =>
          diagnoseSignIn(tenant, query.parse(context.req.query()).email),
        ),
      ),
  );
}
