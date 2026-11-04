import {
  commandJson,
  json,
  body,
  pathParameter,
  uuidParam,
  softDeletion,
  pageSchema,
} from "./schemas.ts";
import { tenantRead } from "./tenant-read.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { platformCommand, platformCommandRead } from "./command.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import { hostnamePattern } from "../../db/schema/columns.ts";
import { pageQuerySchema } from "../pagination.ts";
import {
  findOrganizationDomainForCommand,
  listOrganizationDomains,
} from "../../db/queries/organization-domains.ts";
import {
  domainVerificationRecord,
  lookupTxtRecords,
} from "../../services/domain-verification.ts";
import * as service from "../../services/domains.ts";

export const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(new RegExp(hostnamePattern));
const domainSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  domain: z.string(),
  status: z.enum(lifecycleStatuses),
  verifiedAt: z.iso.datetime().nullable().meta({
    description:
      "When the DNS record was last seen; null until then, and again once a re-check fails.",
  }),
  verificationRecord: z
    .object({
      type: z.literal("TXT"),
      name: z.string(),
      value: z.string(),
    })
    .meta({
      description:
        "What the firm publishes in its DNS to prove the domain. No secret: DNS is public.",
    }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const createSchema = z.object({ domain: hostSchema });
const querySchema = pageQuerySchema.extend({
  status: z.enum(lifecycleStatuses).optional(),
});
const paramSchema = uuidParam("organizationId");
const parameters = [
  pathParameter("organizationId", "uuid"),
] satisfies AdminRoute["parameters"];
const domainParams = paramSchema.extend({ domainId: z.uuid() });
const domainParameters = [
  ...parameters,
  pathParameter("domainId", "uuid"),
] satisfies AdminRoute["parameters"];

export const routes = {
  deleteOrganizationDomain: {
    method: "delete",
    path: "/organizations/:organizationId/domains/:domainId",
    operationId: "deleteOrganizationDomain",
    summary: "Delete organisation domain",
    description: `Delete a domain assignment and return no content, removing its sign-in discovery routing and recording domain.deleted. Prefer disableOrganizationDomain for a reversible suspension; validation_failed rejects malformed ids and not_found means the organisation or domain is missing. No confirmation is required. ${softDeletion}`,
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: domainParameters,
    responses: {
      204: { description: "Domain deleted" },
      ...problemResponses(404),
    },
  },
  listOrganizationDomains: {
    method: "get",
    path: "/organizations/:organizationId/domains",
    operationId: "listOrganizationDomains",
    summary: "List organisation domains",
    description:
      "Return all domains assigned to an organisation without changing state. Use createOrganizationDomain to add a sign-in domain; validation_failed rejects malformed ids and not_found means the organisation is unavailable.",
    tag: "Domains",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    orgScope: "org:read",
    responses: {
      200: {
        description: "Domains",
        content: json(pageSchema(domainSchema)),
      },
      ...problemResponses(400, 404),
    },
  },
  createOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains",
    operationId: "createOrganizationDomain",
    summary: "Create an organisation domain",
    description:
      "Add an email domain to an organisation and return the created domain with the DNS record that proves it, enabling domain-based sign-in discovery. Prefer listOrganizationDomains to inspect existing assignments; validation_failed rejects malformed input, not_found means the organisation is missing, and conflict means the domain is already assigned.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    requestBody: body(createSchema),
    example: { body: { domain: "acme.example.com" } },
    responses: {
      201: {
        description: "Domain",
        content: commandJson(domainSchema),
      },
      ...problemResponses(404),
    },
  },
  disableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/disable",
    operationId: "disableOrganizationDomain",
    summary: "Disable an organisation domain",
    description:
      "Disable an organisation domain and return the updated record. Prefer enableOrganizationDomain for the opposite transition; not_found means the target is missing and an already disabled assignment returns unchanged state and records a noop.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: domainParameters,
    responses: {
      200: {
        description: "Domain",
        content: commandJson(domainSchema),
      },
      ...problemResponses(404),
    },
  },
  enableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/enable",
    operationId: "enableOrganizationDomain",
    summary: "Enable an organisation domain",
    description:
      "Enable an organisation domain and return the updated record. Prefer disableOrganizationDomain for the opposite transition; not_found means the target is missing, and an already active assignment returns unchanged state and records a noop.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: domainParameters,
    responses: {
      200: {
        description: "Domain",
        content: commandJson(domainSchema),
      },
      ...problemResponses(404),
    },
  },
  verifyOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/verify",
    operationId: "verifyOrganizationDomain",
    summary: "Verify an organisation domain",
    description:
      "Look up the domain's verificationRecord in DNS, at most 5 seconds outside any transaction, and return the domain with verifiedAt set. Any one TXT record with that value is enough, and a value split into several strings counts. Already proved, the record still there, returns unchanged state and records a noop. domain_verification_failed means the record was not found and names the record expected; on a domain already proved it also clears verifiedAt, audited as domain.verification_lost, so that the domain fails closed and this answer's Operation-Id names that change. The same Idempotency-Key may ask again after a refusal. Nothing re-checks a proof on a schedule: Not yet. not_found means the organisation or domain is missing.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: domainParameters,
    responses: {
      200: {
        description: "Domain",
        content: commandJson(domainSchema),
      },
      ...problemResponses(404, 409),
    },
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.deleteOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "write",
        { organizationId, domainId },
        204,
        async (platform) => {
          await service.deleteOrganizationDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: null,
            resultReference: { type: "domain", id: domainId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.listOrganizationDomains,
    validate("param", paramSchema),
    validate("query", querySchema),
    async (context) =>
      context.json(
        await tenantRead(context, "directory", async (tenant) => {
          const page = await listOrganizationDomains(
            tenant,
            querySchema.parse(context.req.query()),
          );
          return { ...page, items: page.items.map(service.shownDomain) };
        }),
      ),
  );
  registerRoute(
    app,
    routes.createOrganizationDomain,
    validate("param", paramSchema),
    validate("json", createSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const input = createSchema.parse(await context.req.json());
      return platformCommand(
        context,
        "write",
        { organizationId, ...input },
        201,
        async (platform) => {
          const body = await service.createDomain(
            platform,
            organizationId,
            input,
          );
          return { body, resultReference: { type: "domain", id: body.id } };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.disableOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "write",
        { organizationId, domainId },
        200,
        async (platform) => {
          const result = await service.disableDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: result.row,
            changed: result.changed,
            resultReference: { type: "domain", id: domainId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.enableOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "write",
        { organizationId, domainId },
        200,
        async (platform) => {
          const result = await service.enableDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: result.row,
            changed: result.changed,
            resultReference: { type: "domain", id: domainId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.verifyOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      const input = { organizationId, domainId };
      // No network work belongs in a command's transaction. Look only for a caller the
      // command would admit; a missing row answers there, after any replay of its receipt.
      const domain = await platformCommandRead(context, "write", (platform) =>
        findOrganizationDomainForCommand(platform, organizationId, domainId),
      );
      const records = domain
        ? await lookupTxtRecords(
            context.get("txtResolver"),
            domainVerificationRecord(domain).name,
          )
        : [];
      try {
        return await platformCommand(
          context,
          "write",
          input,
          200,
          async (platform) => {
            const result = await service.proveDomain(
              platform,
              organizationId,
              domainId,
              records,
            );
            return {
              body: result.row,
              changed: result.changed,
              resultReference: { type: "domain", id: domainId },
            };
          },
        );
      } catch (refusal) {
        // A refusal keeps the caller's key free, to ask again once the record is published.
        // What it found still has to commit, under a key of its own.
        if (refusal instanceof service.DomainProofFailed && refusal.wasProved)
          await platformCommand(
            context,
            "write",
            input,
            200,
            async (platform) => {
              const { changed } = await service.endDomainProof(
                platform,
                organizationId,
                domainId,
              );
              return {
                body: null,
                changed,
                resultReference: { type: "domain", id: domainId },
              };
            },
            { serverKey: true },
          );
        throw refusal;
      }
    },
  );
}
