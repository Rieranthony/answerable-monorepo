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
      retiredEmail: z.boolean(),
    })
    .nullable(),
  accounts: z.array(
    z.object({
      issuer: z.string(),
      matchesProvider: z.boolean(),
      directoryId: z.string().nullable(),
    }),
  ),
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
      "Inspect database sign-in checks in resolver order without changing state. Supply an email; routing identifies its active organisation, checked lists evaluated codes and requiresToken lists checks requiring a real IdP token. This email diagnosis cannot prove the token subject or account collisions. A non-effective membership does not stop sign-in but stops every grant. Use testSsoProvider to check discovery connectivity. validation_failed rejects malformed ids or email; not_found means the organisation is missing.",
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
        await diagnoseSignIn(
          context.get("db"),
          context.req.param("organizationId")!,
          query.parse(context.req.query()).email,
        ),
      ),
  );
}
