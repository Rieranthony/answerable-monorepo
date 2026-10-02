import { defineMutation } from "@answerable/mcp"
import { z } from "zod"
import {
  commitWith, errors, invalid, missingOrganisation, named, newKey, noPrecondition, organizationId, precondition, scopes, slug, target,
  type Organisation, type Writes,
} from "./writes"

const name = z.string().trim().min(1).max(200)
// ID's host rule for a domain (apps/id/src/http/admin/domains.ts hostSchema).
const domain = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Must be a domain name such as newco.example")
// The issuers ID signs in through Answerable's own Microsoft or Google application (apps/id/src/services/federation.ts classifyIssuer).
const entra = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/
const google = "https://accounts.google.com"

/** The writes on an organisation itself: create, update, disable and enable it, route a domain to it and set its SSO provider. */
export function organisationWrites(writes: Writes) {
  const { calls, role, platform, fresh, organisation, guard } = writes

  const create = role("admin", defineMutation({
    name: "organisations.create", risk: "normal", scopes, effects: ["publication"],
    description: `Prepare creating an organisation in Answerable ID with a unique slug and a name. ${commitWith} It starts with no domain, SSO provider or access: then domains_add, sso_set, toolbox_enable and access_grant.`,
    input: z.object({
      slug: slug.describe("Unique in Answerable ID: lowercase letters and digits, words joined by single hyphens, such as newco"),
      name: name.describe("The organisation's name, 1 to 200 characters"),
    }),
    output: z.object({ organizationId: z.uuid(), slug: z.string(), operationId: z.uuid() }),
    async prepare({ slug, name }, context) {
      const taken = (await calls.all<Organisation>(`/organizations?q=${slug}`, context)).find(row => row.slug === slug)
      if (taken) throw precondition(`The slug ${slug} belongs to organisation ${named(taken)}, ${taken.id}; choose another`, { slug, organizationId: taken.id })
      return {
        targets: [],
        preview: {
          summary: `Create organisation “${name}” with slug ${slug}`,
          changes: [{ path: `organizations[${slug}]`, from: null, to: { slug, name } }], effects: ["publication" as const],
          warnings: [noPrecondition("creating an organisation")],
        },
        plan: { key: newKey(), slug, name },
      }
    },
    async commit({ plan: { key, slug, name }, preview }, context) {
      const done = await calls.write("POST", "/organizations", { body: { slug, name }, key }, context)
      return { results: { organizationId: done.id, slug, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const fields = ["name", "logo", "metadata"] as const
  const update = role("admin", defineMutation({
    name: "organisations.update", risk: "normal", scopes, errors,
    description: `Prepare changing an organisation's name, logo or metadata in Answerable ID; the slug never changes. ${commitWith} The commit sends the organisation's version as If-Match, so a change made meanwhile is refused.`,
    input: z.object({
      organizationId, name: name.optional().describe("The new name, 1 to 200 characters"),
      logo: z.url().nullable().optional().describe("The logo's URL, or null to remove it"),
      metadata: z.string().max(4000).nullable().optional().describe("Free text, often JSON, up to 4,000 characters, or null to remove it"),
    }),
    output: z.object({ organizationId: z.uuid(), operationId: z.uuid() }),
    async prepare(input, context) {
      const given = fields.filter(field => input[field] !== undefined)
      if (!given.length) throw invalid("name", "Name at least one of name, logo and metadata to change")
      const { organisation: row, target: version } = await organisation(input.organizationId, context)
      const changed = given.filter(field => input[field] !== row[field])
      if (!changed.length) throw precondition(`Organisation ${named(row)} already has these values; nothing would change`, { organizationId: row.id })
      const patch = Object.fromEntries(changed.map(field => [field, input[field]]))
      const shown = (value: unknown) => (value === null ? "none" : `“${value}”`)
      return {
        targets: [version],
        preview: {
          summary: `Update organisation ${named(row)}: ${changed.map(field => `${field} ${shown(row[field])} → ${shown(input[field])}`).join(", ")}`,
          changes: changed.map(field => ({ path: `organizations[${row.id}].${field}`, from: row[field], to: input[field] })),
        },
        plan: { key: newKey(), patch },
      }
    },
    async commit({ targets: [version], plan: { key, patch }, preview }, context) {
      const done = await calls.write("PATCH", `/organizations/${version!.resource_id}`, { body: patch, ifMatch: version!.version.value, key }, context)
      return { results: { organizationId: version!.resource_id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: [] }
    },
  }))

  // Disabling and enabling are critical: an owner with a recent sign-in.
  const status = (to: "active" | "disabled") => role("owner", defineMutation({
    name: to === "disabled" ? "organisations.disable" : "organisations.enable", risk: "normal", scopes, errors,
    effects: to === "disabled" ? ["cascade_delete"] : [],
    description: to === "disabled"
      ? `Prepare disabling an organisation in Answerable ID: its people can no longer get tokens, and every grant it has is revoked. Owner only, with a recent sign-in at your directory. ${commitWith} organisations_enable reverses the status, not the revoked grants.`
      : `Prepare enabling a disabled organisation in Answerable ID, so that its people can sign in again. Owner only, with a recent sign-in at your directory. ${commitWith} Grants revoked when it was disabled stay revoked: people sign in again.`,
    input: z.object({ organizationId }),
    output: z.object({ organizationId: z.uuid(), status: z.enum(["active", "disabled"]), operationId: z.uuid() }),
    async prepare({ organizationId: id }, context) {
      fresh(context.principal)
      if (id === platform && to === "disabled") {
        throw precondition("The platform organisation cannot be disabled through the admin MCP: every member of Answerable staff, you included, would lose access", { organizationId: id })
      }
      const { organisation: row, target: version } = await organisation(id, context)
      if (row.status === to) throw precondition(`Organisation ${named(row)} is already ${to}`, { organizationId: id, status: to })
      return {
        targets: [version],
        preview: to === "disabled" ? {
          summary: `Disable organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].status`, from: row.status, to }], effects: ["cascade_delete" as const],
          warnings: [
            "Its people can no longer get tokens: Answerable ID revokes the organisation's grants at once, so a refresh fails. An access token already issued keeps working until it expires.",
            "organisations_enable restores the status, not the revoked grants: its people sign in again.",
            noPrecondition("disabling an organisation"),
          ],
        } : {
          summary: `Enable organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].status`, from: row.status, to }],
          warnings: ["The grants revoked when it was disabled stay revoked: its people sign in again, and its machine clients get new tokens.", noPrecondition("enabling an organisation")],
        },
        plan: { key: newKey() },
      }
    },
    async commit({ targets: [version], plan: { key }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version!.resource_id}/${to === "disabled" ? "disable" : "enable"}`, { key }, context)
      return { results: { organizationId: version!.resource_id, status: to, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const domainsAdd = role("admin", defineMutation({
    name: "domains.add", risk: "normal", scopes, errors,
    description: `Prepare routing an email domain to an organisation in Answerable ID, so that people with that domain are sent to its sign-in. ${commitWith} A domain belongs to one organisation; set its SSO provider with sso_set.`,
    input: z.object({ organizationId, domain: domain.describe("The email domain, such as newco.example") }),
    output: z.object({ domainId: z.uuid(), domain: z.string(), operationId: z.uuid() }),
    async prepare({ organizationId: id, domain: added }, context) {
      const { organisation: row, target: version } = await organisation(id, context)
      const held = (await calls.all<{ domain: string }>(`/organizations/${id}/domains`, context, missingOrganisation(id))).map(item => item.domain).sort()
      if (held.includes(added)) throw precondition(`${added} is already routed to organisation ${named(row)}`, { organizationId: id, domain: added })
      return {
        targets: [version],
        preview: {
          summary: `Route email domain ${added} to organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].domains`, from: held, to: [...held, added].sort() }],
          warnings: [`If another organisation holds ${added}, Answerable ID refuses the write with 409 conflict.`, noPrecondition("adding a domain")],
        },
        plan: { key: newKey(), domain: added },
      }
    },
    async commit({ targets: [version], plan: { key, domain: added }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version!.resource_id}/domains`, { body: { domain: added }, key }, context)
      return { results: { domainId: done.id, domain: added, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: [] }
    },
  }))

  type Provider = { id: string; issuer: string; domain: string; oidc: { credentials: "platform" | "own" } }
  const ssoSet = role("admin", defineMutation({
    name: "sso.set", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare setting or replacing an organisation's SSO provider in Answerable ID, through Answerable's own Microsoft or Google application: a Microsoft Entra issuer https://login.microsoftonline.com/<tenant id>/v2.0 or https://accounts.google.com. ${commitWith} A directory with its own credentials needs a client secret, which no tool takes.`,
    input: z.object({
      organizationId,
      issuer: z.url().describe("https://login.microsoftonline.com/<tenant id>/v2.0 for Microsoft Entra, or https://accounts.google.com"),
      domain: domain.describe("The email domain people sign in with, such as newco.example"),
    }),
    output: z.object({ ssoProviderId: z.uuid(), operationId: z.uuid() }),
    async prepare({ organizationId: id, issuer, domain: signIn }, context) {
      const application = entra.test(issuer) ? "Microsoft" : issuer === google ? "Google" : null
      if (!application) {
        throw invalid("issuer", `sso_set sets only Answerable's own applications: a Microsoft Entra issuer https://login.microsoftonline.com/<tenant id>/v2.0 or ${google}. A directory with its own credentials needs a client secret, which no tool takes: staff set it with Answerable ID's admin API, as https://www.answerable.org/docs/id/onboard#connect-the-directory shows.`)
      }
      await guard(id, context)
      const row = await calls.need<Organisation>(`/organizations/${id}`, context, missingOrganisation(id))
      const current = await calls.version<Provider>(`/organizations/${id}/sso-provider`, context)
      const now = current && { issuer: current.body.issuer, domain: current.body.domain, credentials: current.body.oidc.credentials }
      const via = `through Answerable's ${application} application`
      return {
        targets: current ? [target("sso_provider", current.body.id, current.body.issuer, current.etag)] : [],
        preview: {
          summary: now
            ? `Replace the SSO provider of organisation ${named(row)}: ${now.issuer} for ${now.domain} → ${issuer} for ${signIn}, ${via}`
            : `Set the SSO provider of organisation ${named(row)}: ${issuer} for ${signIn}, ${via}`,
          changes: [{ path: `organizations[${id}].ssoProvider`, from: now ?? null, to: { issuer, domain: signIn, credentials: "platform" } }],
          effects: ["permission_change" as const],
          warnings: ["When the provider changes, including when it is first set, Answerable ID revokes every grant of the organisation: its people sign in to each application again."],
        },
        plan: { key: newKey(), organizationId: id, issuer, domain: signIn },
      }
    },
    // A replacement names the provider's version; a first provider asserts that there is none yet.
    async commit({ targets: [version], plan: { key, organizationId: id, issuer, domain: signIn }, preview }, context) {
      const precondition = version ? { ifMatch: version.version.value } : { ifNoneMatch: "*" as const }
      const done = await calls.write("PUT", `/organizations/${id}/sso-provider`, { body: { issuer, domain: signIn, oidc: { credentials: "platform" } }, ...precondition, key }, context)
      return { results: { ssoProviderId: done.id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  return [create, update, domainsAdd, ssoSet, status("disabled"), status("active")]
}
