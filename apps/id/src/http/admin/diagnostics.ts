import { tenantRead } from "./tenant-read.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  diagnoseSignIn,
  signInVerdictCodes,
  tokenOnlyCodes,
} from "../../services/diagnostics.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";

const params = uuidParam("organizationId");
const query = z.object({ email: z.email().toLowerCase() });
export const signInDiagnosisSchema = z.object({
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
  user: z
    .object({
      id: z.uuid(),
      status: z.enum(["inert", "active", "disabled"]),
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
      "Inspect tenant-local configuration and membership. Current platform:read or org:users authority is rechecked inside the read transaction. Routing identifies only this organisation; user and membership are null unless this tenant has a membership for the exact email. Global accounts and retired-email state are excluded, including for staff. A null user does not mean the email is globally unused. authentication_required means local checks found no blocker; a real IdP authentication must establish identity and account conflicts. Windows affect grants, not admission; revoked membership requires reinstatement. Responses use no-store. validation_failed rejects malformed input; not_found means the organisation is unavailable.",
    tag: "Diagnostics",
    platformScope: "platform:read",
    orgScope: "org:users",
    kind: "read",
    freshAuthentication: false,
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
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: {
          description: "Sign-in diagnosis",
          content: json(signInDiagnosisSchema),
        },
        ...problemResponses(400, 404),
      },
    ),
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
