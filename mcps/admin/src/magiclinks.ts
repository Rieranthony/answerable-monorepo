import { defineMutation, ToolError, type ToolContext } from "@answerable/mcp"
import { z } from "zod"
import {
  commitWith, errors, missingOrganisation, named, noPrecondition, organizationId, precondition, scopes,
  type Entitlement, type Writes,
} from "./writes"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const people = (count: number) => (count === 1 ? "1 person" : `${count} people`)
// What stays out of reach of every one of these writes, which no write to ID reaches.
const outlives = "A service token already issued lives to its expiry."
// How much of a list a preview or a receipt spells out.
const shown = 20

type Domain = { id: string; domain: string; status: "active" | "disabled"; verifiedAt: string | null; verificationRecord: { type: string; name: string; value: string } }
type ImportAnswer = {
  counts: { created: number; added: number; alreadyMember: number; refused: number }
  items: { address: string; outcome: "created" | "added" | "alreadyMember" | "refused"; reason?: string }[]
}

/**
 * The writes on how an organisation signs in by emailed link, and on who it lists: `magiclink.enable`, `.disable` and `.admission`, `members.import` and
 * `domains.verify`. Each needs a recent directory sign-in, as ID's own route does of a person and does not of a machine client, and a target in the platform
 * organisation needs the owner role, through the organisation's guard. A link does not reach what a directory does, and each preview says what it will not.
 */
export function magicLinkWrites({ calls, role, platform, fresh, organisation, isOwner }: Writes) {
  const directoryOf = (id: string, context: ToolContext) => calls.read<{ issuer: string }>(`/organizations/${id}/sso-provider`, context)
  const domainsOf = (id: string, context: ToolContext) => calls.all<Domain>(`/organizations/${id}/domains`, context, missingOrganisation(id))
  // Grants that reach everyone in the organisation, so anyone new has them at once.
  async function organisationWide(id: string, context: ToolContext) {
    const rows = await calls.all<Entitlement>(`/organizations/${id}/entitlements`, context, missingOrganisation(id))
    return rows.filter(row => row.status === "active" && row.memberId === null && row.groupId === null)
  }
  const reach = (rows: Entitlement[]) => [...new Set(rows.map(row => row.resource ?? row.clientId))].toSorted().join(", ")
  const output = z.object({ organizationId: z.uuid(), enabled: z.boolean(), operationId: z.uuid() })

  const switching = (enabled: boolean) => role("admin", defineMutation({
    name: enabled ? "magiclink.enable" : "magiclink.disable", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: enabled
      ? `Prepare turning sign-in by emailed link on for an organisation in Answerable ID, whether or not it has a directory. ${commitWith} magiclink_admission says who may ask for a link; the platform organisation can never use them.`
      : `Prepare turning sign-in by emailed link off for an organisation in Answerable ID: its magic-link sessions and grants end, and directory sign-ins, sessions and grants are not touched. ${commitWith} This is how an organisation requires its directory only. magiclink_enable reverses the setting, not what it ended.`,
    input: z.object({ organizationId }),
    output,
    async prepare({ organizationId: id }, context) {
      fresh(context.principal)
      const { organisation: row, target: version } = await organisation(id, context)
      if (enabled && id === platform) throw precondition("The platform organisation can never use magic links: staff sign in through its directory", { organizationId: id })
      if (row.magicLink.enabled === enabled) throw precondition(`Magic links are already ${enabled ? "on" : "off"} for organisation ${named(row)}`, { organizationId: id, enabled })
      const directory = await directoryOf(id, context)
      return {
        targets: [version],
        preview: {
          summary: `Turn magic links ${enabled ? "on" : "off"} for organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].magicLink.enabled`, from: !enabled, to: enabled }],
          effects: ["permission_change" as const],
          warnings: enabled ? [
            `Who may ask for a link: ${row.magicLink.admission === "listed" ? `its ${plural(row.magicLink.listed, "effective member")}` : `its ${plural(row.magicLink.listed, "effective member")}, and anyone at a proved domain, whom a first sign-in creates`}.`,
            ...(directory ? ["A magic link does not pass through the directory's MFA or conditional access, and someone disabled there can still use a link while their mailbox works; remove the member in Answerable ID, with members_remove, to stop both."] : []),
            "Sessions and grants ended when links were turned off stay ended: their people sign in again.",
            noPrecondition("turning magic links on"),
          ] : [
            ...(directory ? [] : ["It has no directory, so nobody at this organisation can then sign in."]),
            "Ends every magic-link session and grant at this organisation. It does not touch directory sign-ins, sessions or grants.",
            outlives,
            "magiclink_enable turns links back on and revives none of what this ended.",
            noPrecondition("turning magic links off"),
          ],
        },
        plan: { enabled },
      }
    },
    async commit({ intent_id, targets: [version], plan: { enabled }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version.resource_id}/magic-link/${enabled ? "enable" : "disable"}`, { key: intent_id }, context)
      return { results: { organizationId: version.resource_id, enabled, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  // An admin may narrow who may ask; widening it to anyone at a domain is an owner's.
  const admission = role("admin", defineMutation({
    name: "magiclink.admission", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare setting who may ask an organisation for a magic link in Answerable ID. listed: its effective members. domain: also anyone with an address at a domain that has passed domains_verify, whom a first sign-in creates; that needs the owner role, and every active domain proved. Removed members and disabled people are refused in both. ${commitWith} It ends no session and no grant, and existing members stay members.`,
    input: z.object({ organizationId, admission: z.enum(["listed", "domain"]).describe("listed: the organisation's effective members; domain: also anyone at one of its proved domains") }),
    output: z.object({ organizationId: z.uuid(), admission: z.enum(["listed", "domain"]), operationId: z.uuid() }),
    async prepare({ organizationId: id, admission: to }, context) {
      fresh(context.principal)
      const { organisation: row, target: version } = await organisation(id, context)
      if (to === "domain" && !await isOwner(context)) throw new ToolError("PERMISSION_DENIED", "Opening an organisation to anyone at its domains is an owner's: a new person would have its organisation-wide access at once")
      if (to === "domain" && id === platform) throw precondition("The platform organisation can never use magic links: staff sign in through its directory", { organizationId: id })
      if (row.magicLink.admission === to) throw precondition(`Organisation ${named(row)} already admits ${to}; nothing would change`, { organizationId: id, admission: to })
      const domains = (await domainsOf(id, context)).filter(item => item.status === "active")
      const unverified = domains.filter(item => item.verifiedAt === null).map(item => item.domain)
      if (to === "domain" && (!domains.length || unverified.length)) {
        throw precondition(domains.length
          ? `Every active domain must be proved first: ${unverified.join(", ")}. domains_verify checks each, once its DNS record is published`
          : `Organisation ${named(row)} has no active domain: domains_add one, then domains_verify it`, { organizationId: id, unverified })
      }
      const wide = to === "domain" ? await organisationWide(id, context) : []
      return {
        targets: [version],
        preview: {
          summary: to === "domain"
            ? `Let anyone at a proved domain of organisation ${named(row)} ask for a magic link: ${domains.map(item => item.domain).join(", ")}`
            : `Let only the effective members of organisation ${named(row)} ask for a magic link`,
          changes: [{ path: `organizations[${id}].magicLink.admission`, from: row.magicLink.admission, to }],
          effects: ["permission_change" as const],
          warnings: to === "domain" ? [
            ...(row.magicLink.enabled ? [] : ["Magic links are off here, so this has no effect until magiclink_enable."]),
            ...(wide.length ? [`${plural(wide.length, "organisation-wide entitlement")} ${wide.length === 1 ? "exists" : "exist"}, so a new person would have access at once: ${reach(wide)}.`] : []),
            "An alias of a removed person is a different address, which Answerable ID cannot recognise: it could sign in as someone new. Removing a member stops that one address.",
            "A shared mailbox or a distribution list at these domains becomes one person, whoever reads it.",
            "Mail can now reach addresses nobody holds: at most 100 an hour from one client and 500 a day for the organisation. Beyond them a new person gets no mail, so a firm-wide start uses members_import first, since listed people are not new addresses.",
            "A domain added later admits nobody new until it is proved. Nothing re-checks a proof on a schedule, so a lapsed domain someone re-registers stays proved until domains_verify runs again.",
            noPrecondition("changing who may ask"),
          ] : [
            "People who are not yet members can no longer ask. Existing members stay members, and no session or grant ends.",
            noPrecondition("changing who may ask"),
          ],
        },
        plan: { admission: to },
      }
    },
    async commit({ intent_id, targets: [version], plan: { admission: to }, preview }, context) {
      const done = await calls.write("PATCH", `/organizations/${version.resource_id}/magic-link`, { body: { admission: to }, key: intent_id }, context)
      return { results: { organizationId: version.resource_id, admission: to, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const counts = z.object({ created: z.number().int(), added: z.number().int(), alreadyMember: z.number().int(), refused: z.number().int() })
  const memberImport = role("admin", defineMutation({
    name: "members.import", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare listing people in an organisation in Answerable ID before their first sign-in, so that their sub exists first: a user and an active membership for each address, at most 1,000, and no account, which the first sign-in makes. Each address has its own answer, and one refused does not stop the rest: refused when invalid, outside the organisation's active domains, public mail, a disabled person, a removed member, whom only members_reinstate brings back, or an account of another organisation. ${commitWith} It sends no mail, and works with magic links off and with a directory connected.`,
    input: z.object({
      organizationId,
      addresses: z.array(z.string().min(1).max(1000).describe("An email address, in any case")).min(1).max(1000).describe("The addresses to list, at most 1,000; repeats count once"),
    }),
    output: z.object({
      organizationId: z.uuid(), operationId: z.uuid(),
      counts: counts.nullable().describe("How many had each outcome; null when ID replayed the write, and audit_list by operationId shows who it made"),
      refused: z.array(z.object({ address: z.string(), reason: z.string() })).describe(`The refused addresses and why, the first ${shown}`),
    }),
    async prepare({ organizationId: id, addresses }, context) {
      fresh(context.principal)
      const { organisation: row, target: version } = await organisation(id, context)
      const answer = await calls.ask<ImportAnswer>(`/organizations/${id}/members/import/preview`, { addresses }, context, missingOrganisation(id))
      const { created, added, alreadyMember, refused } = answer.counts
      if (!created && !added) throw precondition(`Importing these addresses would change nothing in organisation ${named(row)}: ${alreadyMember} already members, ${refused} refused`, { organizationId: id, counts: answer.counts, refused: refusedOf(answer) })
      const directory = await directoryOf(id, context)
      const wide = await organisationWide(id, context)
      const spelled = refusedOf(answer)
      return {
        targets: [version],
        preview: {
          summary: `List ${people(created + added)} in organisation ${named(row)}: ${created} new, ${added} existing users added; ${alreadyMember} already members, ${refused} refused`,
          changes: [{ path: `organizations[${id}].magicLink.listed`, from: row.magicLink.listed, to: row.magicLink.listed + created + added }],
          effects: ["permission_change" as const],
          warnings: [
            ...(spelled.length ? [`Refused: ${spelled.map(item => `${item.address} (${item.reason})`).join(", ")}${refused > spelled.length ? `, and ${refused - spelled.length} more` : ""}.`] : []),
            "Sends no mail. Each person's account is made at their first sign-in. A removed member and a disabled person stay as they are.",
            ...(wide.length ? [`${plural(wide.length, "organisation-wide entitlement")} ${wide.length === 1 ? "exists" : "exist"}, so each new member has access at once: ${reach(wide)}.`] : []),
            ...(row.magicLink.enabled ? [] : ["Magic links are off here, so nobody listed can sign in by link until magiclink_enable."]),
            ...(directory ? ["A directory is connected: until connecting it to an existing person is built, a listed person's first directory sign-in answers email_conflict, so list people here only when they sign in by link."] : []),
            noPrecondition("importing members"),
          ],
          quantities: [
            { name: "created", value: created, unit: "people" }, { name: "added", value: added, unit: "people" },
            { name: "alreadyMember", value: alreadyMember, unit: "people" }, { name: "refused", value: refused, unit: "addresses" },
          ],
        },
        plan: { addresses },
      }
    },
    async commit({ intent_id, targets: [version], plan: { addresses }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version.resource_id}/members/import`, { body: { addresses }, key: intent_id, scope: "users" }, context)
      const answer = done.replayed ? null : done.body as ImportAnswer
      return {
        results: { organizationId: version.resource_id, operationId: done.operationId, counts: answer?.counts ?? null, refused: answer ? refusedOf(answer) : [] },
        applied_changes: preview.changes, effects_performed: preview.effects,
      }
    },
  }))

  const verify = role("admin", defineMutation({
    name: "domains.verify", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare checking an organisation's email domain in DNS with Answerable ID: a TXT record at _answerable-challenge.<domain> with the value domains_add and organisations_get give. Found, the domain is proved. Not found on a domain already proved, the proof is cleared, so that it fails closed. ${commitWith} magiclink_admission needs every active domain proved before anyone at them may ask for a link.`,
    input: z.object({ organizationId, domain: z.string().trim().toLowerCase().min(1).max(253).describe("The email domain, as organisations_get shows it") }),
    output: z.object({ domainId: z.uuid(), domain: z.string(), verifiedAt: z.iso.datetime().nullable().describe("When the record was seen; null when ID replayed the write, and organisations_get shows it"), operationId: z.uuid() }),
    async prepare({ organizationId: id, domain: name }, context) {
      fresh(context.principal)
      const { organisation: row, target: version } = await organisation(id, context)
      const domain = (await domainsOf(id, context)).find(item => item.domain === name)
      if (!domain) throw precondition(`${name} is not routed to organisation ${named(row)}; domains_add routes it`, { organizationId: id, domain: name })
      const { type, name: at, value } = domain.verificationRecord
      return {
        targets: [version],
        preview: {
          summary: `Check the DNS record that proves ${name} for organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].domains[${domain.id}].verifiedAt`, from: domain.verifiedAt, to: "the time the record is seen, or null when it is not found" }],
          effects: ["permission_change" as const],
          warnings: [
            `Answerable ID looks for a ${type} record at ${at} with the value ${value}. The commit fails when it is not there.`,
            ...(domain.verifiedAt ? [`${name} is proved now: if the record is gone, this clears that, and it admits nobody new until it is proved again. Nobody's session ends.`] : []),
            noPrecondition("checking a domain"),
          ],
        },
        plan: { domainId: domain.id, domain: name, record: domain.verificationRecord, proved: domain.verifiedAt !== null },
      }
    },
    async commit({ intent_id, targets: [version], plan: { domainId, domain: name, record, proved }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version.resource_id}/domains/${domainId}/verify`, { key: intent_id }, context).catch((error: unknown) => {
        const { upstream } = (error instanceof ToolError ? error.details : undefined) as { upstream?: { code?: string } } ?? {}
        if (upstream?.code !== "domain_verification_failed") throw error
        throw precondition(`Answerable ID did not find the ${record.type} record at ${record.name} with the value ${record.value}${proved ? `, so ${name} is no longer proved` : ""}. DNS can take time: publish it, then prepare this again`, { domain: name, expected: record })
      })
      // A replay answers ID's receipt, which holds no time.
      const { verifiedAt = null } = done.body as { verifiedAt?: string | null }
      return { results: { domainId, domain: name, verifiedAt, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  return [switching(true), switching(false), admission, memberImport, verify]
}

// The refused addresses of an answer, as far as a preview or a receipt spells them out.
const refusedOf = ({ items }: ImportAnswer) => items
  .filter(item => item.outcome === "refused")
  .slice(0, shown)
  .map(({ address, reason }) => ({ address, reason: reason! }))
