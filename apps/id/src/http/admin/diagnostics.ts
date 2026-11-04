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
    admitted: z
      .boolean()
      .describe(
        "Whether this address may ask this firm for a link now: its switch, its admission and the person",
      ),
    suppressed: z.boolean(),
    lastRequest: z
      .object({
        id: z.uuid(),
        purpose: z.enum(magicLinkPurposes),
        sendStatus: z.enum(magicLinkSendStatuses),
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
      "Inspect tenant-local configuration and membership. Current platform:read or org:users authority is rechecked inside the read transaction. Routing identifies only this organisation; user and membership are null unless this tenant has a membership for the exact email. Global accounts and retired-email state are excluded, including for staff. A null user does not mean the email is globally unused. authentication_required means local checks found no blocker; a real IdP authentication or a magic link's confirmation must establish identity and account conflicts. provider describes the directory; magicLink is the organisation's setting and the newest sign-in mail for this exact email, kept for seven days. magic_link_not_admitted means a link is the way in and admission would refuse this address: its firm's switch and mode and the person, which magicLink.admitted reports in every case. That one field reads a global account: in domain mode, on this organisation's own proved domain, it is false for an address whose holder is disabled or has another firm's account, which is no more than those mailboxes would show by asking for a link. magic_link_suppressed means a link is the way in and Postmark refused the last send as a suppressed address (406), which staff reactivate in Postmark. magicLink.directoryConnection is a directory sign-in this address has made and not yet connected, waiting on the code mailed to it. Windows affect grants, not admission; revoked membership requires reinstatement. Responses use no-store. validation_failed rejects malformed input; not_found means the organisation is unavailable.",
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
