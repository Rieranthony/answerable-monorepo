import type { Hono } from "hono";
import { z } from "zod";
import { getPlatformSummary } from "../../services/summary.ts";
import type { AppEnvironment } from "../context.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json } from "./schemas.ts";

const counter = z.number().int().nonnegative();
export const platformSummarySchema = z.object({
  platform: z.object({
    organizationId: z.uuid().nullable(),
    groupId: z.uuid().nullable(),
  }),
  organizations: z.object({ active: counter, disabled: counter }),
  users: z.object({ inert: counter, active: counter, disabled: counter }),
  clients: z.object({ total: counter, disabled: counter, unowned: counter }),
  resources: z.object({ total: counter, disabled: counter }),
  sessions: z.object({ active: counter }),
  signIns24h: z.object({
    succeeded: counter,
    rejected: counter,
    rejectedByReason: z.record(z.string(), counter),
  }),
  denied24h: counter,
});
export const routes = {
  getPlatformSummary: {
    method: "get",
    path: "/platform/summary",
    operationId: "getPlatformSummary",
    summary: "Summarise the fleet",
    description:
      "Read fleet counts without paging or changing state. Organisations and users are counted by stored status; client and resource totals include disabled rows, and unowned clients have no organisation. Active sessions expire strictly after the current instant. Platform ids identify the configured platform organisation and platform-admins group, or are null when absent. Sign-ins and admin.denied events cover the trailing 24 hours in UTC, including the cutoff instant; rejection reasons count auth.signin.rejected rows with a recorded reason. Rejections have no organisation and cannot be attributed to tenants. Use getOrganizationSummary for one organisation.",
    tag: "Platform",
    platformScope: "platform:read",
    kind: "read",
    responses: standardResponses(
      {},
      {
        200: {
          description: "Fleet summary",
          content: json(platformSummarySchema),
        },
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(app, routes.getPlatformSummary, async (context) =>
    context.json(
      await getPlatformSummary(context.get("db"), context.get("environment")),
    ),
  );
}
