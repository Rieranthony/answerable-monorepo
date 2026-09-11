import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createEntitlement } from "../../__tests__/entitlement-queries.ts";
import {
  createGroup,
  removeGroupMember,
} from "../../__tests__/group-queries.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import {
  auditEvents,
  entitlements,
  groups,
  members,
  oauthResources,
  organizations,
  ssoProviders,
  users,
} from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture();
});
afterEach(async () => fixture?.close());
const cases = [
  {
    name: "assignment creation and replacement preconditions protect recreated pairs and historical replay",
    run: async () => {
      const org = fixture.tenant.organizationId;
      const member = fixture.principals.tenantAdmin.memberId;
      const group = await createGroup(fixture.db, {
        organizationId: org,
        slug: "assignment-revision",
        name: "Assignment",
      });
      const path = `/api/admin/v1/organizations/${org}/groups/${group.id}/members/${member}`;
      const read = (
        kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
      ) => fixture.app.request(path, { headers: fixture.headers(kind) });
      const put = (
        key: string,
        condition: Record<string, string>,
        body = {},
      ) => {
        const headers = fixture.headers("platformAdmin");
        headers.set("Idempotency-Key", key);
        headers.set("Content-Type", "application/json");
        for (const [name, value] of Object.entries(condition))
          headers.set(name, value);
        return fixture.app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
      };
      expect((await read()).status).toBe(404);
      expect(
        (await put("invalid", { "If-None-Match": '"other"' })).status,
      ).toBe(400);
      const created = await put("create", { "If-None-Match": "*" });
      expect(created.status).toBe(201);
      expect((await put("missing", {})).status).toBe(200);
      const original = await created.json();
      const originalTag = created.headers.get("ETag")!;
      expect(originalTag).toBe(`"${original.id}:1"`);
      const current = await read("tenantReader");
      expect(current.status).toBe(200);
      expect(await current.json()).toEqual(original);
      expect(current.headers.get("ETag")).toBe(originalTag);
      expect((await read("outsider")).status).toBe(404);
      expect((await put("exists", { "If-None-Match": "*" })).status).toBe(412);
      expect(
        (await put("both", { "If-None-Match": "*", "If-Match": originalTag }))
          .status,
      ).toBe(400);
      expect(
        (await put("weak", { "If-Match": `W/${originalTag}` })).status,
      ).toBe(400);
      const changed = await put(
        "change",
        { "If-Match": originalTag },
        { validUntil: "2100-01-01T00:00:00.000Z" },
      );
      expect(changed.status).toBe(200);
      const saved = await changed.json();
      const nextTag = changed.headers.get("ETag")!;
      expect(saved.id).toBe(original.id);
      expect(saved.revision).toBe(2);
      expect((await put("stale", { "If-Match": originalTag })).status).toBe(
        412,
      );
      const replayCreate = await put("create", { "If-None-Match": "*" });
      expect(replayCreate.status).toBe(201);
      expect(replayCreate.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, replayCreate);
      const noop = await put("noop", { "If-Match": nextTag });
      expect(noop.status).toBe(200);
      expect(await noop.json()).toEqual(saved);
      expect(noop.headers.get("ETag")).toBe(nextTag);
      expect(
        (
          await put(
            "change",
            { "If-Match": nextTag },
            { validUntil: "2100-01-01T00:00:00.000Z" },
          )
        ).status,
      ).toBe(409);
      const race = await Promise.all([
        put("race-a", { "If-Match": nextTag }, { validUntil: null }),
        put(
          "race-b",
          { "If-Match": nextTag },
          { validFrom: "2000-01-01T00:00:00.000Z" },
        ),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 412]);
      await removeGroupMember(fixture.db, org, group.id, member);
      expect((await put("gone", { "If-Match": nextTag })).status).toBe(412);
      const replacements = await Promise.all([
        put("recreate-a", { "If-None-Match": "*" }),
        put("recreate-b", { "If-None-Match": "*" }),
      ]);
      expect(replacements.map((r) => r.status).sort()).toEqual([201, 412]);
      const replacement = await (await read()).json();
      expect(replacement.id).not.toBe(original.id);
      expect(replacement.revision).toBe(1);
      expect(
        (await put("old-instance", { "If-Match": originalTag })).status,
      ).toBe(412);
      const historical = await put(
        "change",
        { "If-Match": originalTag },
        { validUntil: "2100-01-01T00:00:00.000Z" },
      );
      expect(historical.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, historical);
      expect(await (await read()).json()).toEqual(replacement);
    },
  },
  {
    name: "entitlement revisions reject stale and recreated targets without breaking replay",
    run: async () => {
      const path = (id: string) =>
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements/${id}`;
      const read = (id: string) =>
        fixture.app.request(path(id), {
          headers: fixture.headers("platformAdmin"),
        });
      function patch(
        id: string,
        key: string,
        tag?: string,
        scopes = ["write"],
      ) {
        const headers = fixture.headers("platformAdmin");
        headers.set("Idempotency-Key", key);
        headers.set("Content-Type", "application/json");
        if (tag !== undefined) headers.set("If-Match", tag);
        return fixture.app.request(path(id), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ scopes }),
        });
      }

      await fixture.db.insert(oauthResources).values({
        id: Bun.randomUUIDv7(),
        identifier: "https://entitlement-revision.example.com",
        name: "Revision",
        allowedScopes: ["read", "write"],
      });
      const entitlement = await createEntitlement(fixture.db, {
        organizationId: fixture.tenant.organizationId,
        resource: "https://entitlement-revision.example.com",
        scopes: ["read"],
      });
      const first = await read(entitlement.id);
      const tag = first.headers.get("ETag")!;
      expect(tag).toBeString();
      const changed = await patch(entitlement.id, "first", tag);
      expect(changed.status).toBe(200);
      const saved = await changed.json();
      const nextTag = changed.headers.get("ETag")!;
      expect(saved.revision).toBe(entitlement.revision + 1);
      expect((await patch(entitlement.id, "stale", tag, ["read"])).status).toBe(
        412,
      );
      const replay = await patch(entitlement.id, "first", tag);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, replay);
      const noop = await patch(entitlement.id, "noop", nextTag);
      expect(noop.status).toBe(200);
      expect(await noop.json()).toEqual(saved);
      expect((await patch(entitlement.id, "missing")).status).toBe(200);
      expect((await patch(entitlement.id, "weak", `W/${nextTag}`)).status).toBe(
        400,
      );
      expect((await patch(entitlement.id, "first", nextTag)).status).toBe(409);
      await expect(
        fixture.db
          .update(entitlements)
          .set({ revision: 1 })
          .where(eq(entitlements.id, entitlement.id))
          .execute(),
      ).rejects.toThrow();
      expect((await read(entitlement.id)).headers.get("ETag")).toBe(nextTag);
      const [event] = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, changed.headers.get("Operation-Id")!),
        );
      expect(event?.data).toMatchObject({
        before: { revision: entitlement.revision },
        after: { revision: saved.revision },
      });
      for (const suffix of ["/disable", "/enable"]) {
        expect(
          (
            await fixture.app.request(path(entitlement.id) + suffix, {
              method: "POST",
              headers: fixture.headers("platformAdmin"),
            })
          ).status,
        ).toBe(200);
        expect(
          (await patch(entitlement.id, `stale-${suffix}`, nextTag)).status,
        ).toBe(412);
      }
      const beforeRaw = await read(entitlement.id);
      const rawTag = beforeRaw.headers.get("ETag")!;
      await fixture.db.execute(
        sql`update entitlements set valid_until = '2100-01-01T00:00:00Z' where id = ${entitlement.id}`,
      );
      const raw = await read(entitlement.id);
      expect(raw.headers.get("ETag")).not.toBe(rawTag);
      const current = raw.headers.get("ETag")!;
      const competing = await Promise.all([
        patch(entitlement.id, "race-a", current, ["read"]),
        patch(entitlement.id, "race-b", current, ["read", "write"]),
      ]);
      expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
      expect(
        (
          await fixture.app.request(path(entitlement.id), {
            method: "DELETE",
            headers: fixture.headers("platformAdmin"),
          })
        ).status,
      ).toBe(204);
      const replacement = await createEntitlement(fixture.db, {
        organizationId: fixture.tenant.organizationId,
        resource: entitlement.resource!,
        scopes: ["read"],
      });
      expect((await patch(replacement.id, "wrong-instance", tag)).status).toBe(
        412,
      );
    },
  },
  {
    name: "group revisions reject stale and recreated targets without breaking replay",
    run: async () => {
      const path = (id: string) =>
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups/${id}`;
      const read = (id: string) =>
        fixture.app.request(path(id), {
          headers: fixture.headers("platformAdmin"),
        });
      function patch(id: string, key: string, tag?: string, name = "Updated") {
        const headers = fixture.headers("platformAdmin");
        headers.set("Idempotency-Key", key);
        headers.set("Content-Type", "application/json");
        if (tag !== undefined) headers.set("If-Match", tag);
        return fixture.app.request(path(id), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name }),
        });
      }

      const group = await createGroup(fixture.db, {
        organizationId: fixture.tenant.organizationId,
        slug: "group-revision",
        name: "Original",
      });
      const first = await read(group.id);
      const tag = first.headers.get("ETag")!;
      expect(tag).toBeString();
      const changed = await patch(group.id, "first", tag);
      expect(changed.status).toBe(200);
      const saved = await changed.json();
      const nextTag = changed.headers.get("ETag")!;
      expect(saved.revision).toBe(group.revision + 1);
      expect((await patch(group.id, "stale", tag, "Stale")).status).toBe(412);
      const replay = await patch(group.id, "first", tag);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, replay);
      const noop = await patch(group.id, "noop", nextTag);
      expect(noop.status).toBe(200);
      expect(await noop.json()).toEqual(saved);
      expect((await patch(group.id, "missing")).status).toBe(200);
      expect((await patch(group.id, "weak", `W/${nextTag}`)).status).toBe(400);
      expect((await patch(group.id, "first", nextTag)).status).toBe(409);
      await expect(
        fixture.db
          .update(groups)
          .set({ revision: 1 })
          .where(eq(groups.id, group.id))
          .execute(),
      ).rejects.toThrow();
      expect((await read(group.id)).headers.get("ETag")).toBe(nextTag);
      const [event] = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, changed.headers.get("Operation-Id")!),
        );
      expect(event?.data).toMatchObject({
        before: { revision: group.revision },
        after: { revision: saved.revision },
      });
      for (const suffix of ["/disable", "/enable"]) {
        expect(
          (
            await fixture.app.request(path(group.id) + suffix, {
              method: "POST",
              headers: fixture.headers("platformAdmin"),
            })
          ).status,
        ).toBe(200);
        expect((await patch(group.id, `stale-${suffix}`, nextTag)).status).toBe(
          412,
        );
      }
      const beforeRaw = await read(group.id);
      const rawTag = beforeRaw.headers.get("ETag")!;
      await fixture.db.execute(
        sql`update groups set external_id = 'directory-revision' where id = ${group.id}`,
      );
      const raw = await read(group.id);
      expect(raw.headers.get("ETag")).not.toBe(rawTag);
      const current = raw.headers.get("ETag")!;
      const competing = await Promise.all([
        patch(group.id, "race-a", current, "A"),
        patch(group.id, "race-b", current, "B"),
      ]);
      expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
      expect(
        (
          await fixture.app.request(`${path(group.id)}?confirm=${group.id}`, {
            method: "DELETE",
            headers: fixture.headers("platformAdmin"),
          })
        ).status,
      ).toBe(204);
      const replacement = await createGroup(fixture.db, {
        organizationId: fixture.tenant.organizationId,
        slug: `${group.slug}-replacement`,
        name: "Replacement",
      });
      expect((await patch(replacement.id, "wrong-instance", tag)).status).toBe(
        412,
      );
    },
  },
  {
    name: "member configuration revisions prevent stale writes and preserve committed replay",
    run: async () => {
      const path = () =>
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
      const read = () =>
        fixture.app.request(`${path()}/configuration`, {
          headers: fixture.headers("tenantUsersOnly"),
        });
      function patch(
        key: string,
        tag?: string,
        validUntil: string | null = "2100-01-01T00:00:00.000Z",
      ) {
        const headers = fixture.headers("tenantUsersOnly");
        headers.set("Idempotency-Key", key);
        headers.set("content-type", "application/json");
        if (tag !== undefined) headers.set("If-Match", tag);
        return fixture.app.request(path(), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ validUntil }),
        });
      }

      const initial = await read();
      expect(initial.status).toBe(200);
      const tag = initial.headers.get("ETag")!;
      expect(tag).toBeString();
      const before = await initial.json();
      expect(before).not.toHaveProperty("groups");
      expect(before).not.toHaveProperty("email");
      expect(before).not.toHaveProperty("effective");
      const changed = await patch("first", tag);
      expect(changed.status).toBe(200);
      expect((await changed.json()).revision).toBe(before.revision + 1);
      expect(
        (await patch("first", tag)).headers.get("Idempotency-Replayed"),
      ).toBe("true");
      const stale = await patch("second", tag, null);
      expect(stale.status).toBe(412);
      expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
      const current = await read();
      const currentTag = current.headers.get("ETag")!;
      const unchanged = await patch("noop", currentTag);
      expect(unchanged.status).toBe(200);
      expect((await read()).headers.get("ETag")).toBe(currentTag);
      expect((await patch("missing")).status).toBe(200);
      expect((await patch("weak", `W/${currentTag}`)).status).toBe(400);
      const original = await fixture.db
        .select()
        .from(members)
        .where(eq(members.id, before.id));
      await expect(
        fixture.db
          .update(members)
          .set({ revision: before.revision })
          .where(eq(members.id, before.id))
          .execute(),
      ).rejects.toThrow();
      expect(
        await fixture.db
          .select()
          .from(members)
          .where(eq(members.id, before.id)),
      ).toEqual(original);
      await fixture.db
        .update(users)
        .set({ name: "Changed display name" })
        .where(eq(users.id, before.userId));
      expect((await read()).headers.get("ETag")).toBe(currentTag);
      for (const [method, suffix] of [
        ["DELETE", ""],
        ["POST", "/reinstate"],
      ] as const) {
        const changed = await fixture.app.request(path() + suffix, {
          method,
          headers: fixture.headers("tenantUsersOnly"),
        });
        expect(changed.status).toBe(method === "DELETE" ? 204 : 200);
        expect((await read()).headers.get("ETag")).not.toBe(currentTag);
        expect((await patch(`after-${method}`, currentTag)).status).toBe(412);
      }
    },
  },
  {
    name: "organisation revision rejects stale edits while replay preserves its original result",
    run: async () => {
      const path = () =>
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}`;
      const read = () =>
        fixture.app.request(path(), {
          headers: fixture.headers("platformAdmin"),
        });
      function patch(key: string, tag?: string, name = "Revised tenant") {
        const headers = fixture.headers("platformAdmin");
        headers.set("Idempotency-Key", key);
        headers.set("Content-Type", "application/json");
        if (tag !== undefined) headers.set("If-Match", tag);
        return fixture.app.request(path(), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name }),
        });
      }

      const initial = await read();
      const tag = initial.headers.get("ETag")!;
      expect(tag).toBeString();
      const before = await initial.json();
      const changed = await patch("org-revision-first", tag);
      expect(changed.status).toBe(200);
      const saved = await changed.json();
      expect(saved.revision).toBe(before.revision + 1);
      const stale = await patch("org-revision-stale", tag, "Stale overwrite");
      expect(stale.status).toBe(412);
      expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
      const currentTag = changed.headers.get("ETag")!;
      expect((await read()).headers.get("ETag")).toBe(currentTag);
      const noop = await patch("org-revision-noop", currentTag);
      expect(noop.status).toBe(200);
      expect(await noop.json()).toEqual(saved);
      expect(noop.headers.get("ETag")).toBe(currentTag);
      const replay = await patch("org-revision-first", tag);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, replay);
      expect((await patch("org-revision-first", currentTag)).status).toBe(409);
      expect((await patch("org-revision-missing")).status).toBe(200);
      expect((await patch("org-revision-weak", `W/${currentTag}`)).status).toBe(
        400,
      );
      expect(
        (await patch("org-revision-other", `"${crypto.randomUUID()}:1"`))
          .status,
      ).toBe(412);
      const events = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, changed.headers.get("Operation-Id")!),
        );
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({
        before: { revision: before.revision },
        after: { revision: saved.revision },
      });
      await expect(
        fixture.db
          .update(organizations)
          .set({ revision: 1 })
          .where(eq(organizations.id, before.id))
          .execute(),
      ).rejects.toThrow();
      expect((await read()).headers.get("ETag")).toBe(currentTag);
      for (const suffix of ["/disable", "/enable"]) {
        const response = await fixture.app.request(path() + suffix, {
          method: "POST",
          headers: fixture.headers("platformAdmin"),
        });
        expect(response.status).toBe(200);
        expect((await read()).headers.get("ETag")).not.toBe(currentTag);
        expect((await patch(`org-revision-${suffix}`, currentTag)).status).toBe(
          412,
        );
      }
      const active = await read();
      const activeTag = active.headers.get("ETag")!;
      const activeRow = await active.json();
      await fixture.db.execute(
        sql`update organizations set metadata = 'changed externally' where id = ${before.id}`,
      );
      const external = await read();
      expect(external.headers.get("ETag")).not.toBe(activeTag);
      expect((await external.json()).revision).toBe(activeRow.revision + 1);
      expect((await patch("org-revision-external", activeTag)).status).toBe(
        412,
      );
      const externalTag = external.headers.get("ETag")!;
      await fixture.db.execute(
        sql`update organizations set metadata = metadata where id = ${before.id}`,
      );
      expect((await read()).headers.get("ETag")).toBe(externalTag);
      const competing = await Promise.all([
        patch("org-revision-racer-a", externalTag, "Racer A"),
        patch("org-revision-racer-b", externalTag, "Racer B"),
      ]);
      expect(competing.map((response) => response.status).sort()).toEqual([
        200, 412,
      ]);
    },
  },
  {
    name: "SSO creation and replacement accept optional preconditions and preserve historical replay",
    run: async () => {
      const input = {
        issuer: "https://sso.example.com",
        domain: "sso.example.com",
        oidc: { clientId: "sso", clientSecret: "original-secret" },
      };
      function put(
        org: string,
        key: string,
        headers: Record<string, string>,
        body: unknown = input,
      ) {
        const auth = fixture.headers("platformAdmin");
        auth.set("Idempotency-Key", key);
        auth.set("Content-Type", "application/json");
        for (const [name, value] of Object.entries(headers))
          auth.set(name, value);
        return fixture.app.request(
          `/api/admin/v1/organizations/${org}/sso-provider`,
          { method: "PUT", headers: auth, body: JSON.stringify(body) },
        );
      }
      const read = (org: string) =>
        fixture.app.request(`/api/admin/v1/organizations/${org}/sso-provider`, {
          headers: fixture.headers("platformAdmin"),
        });

      const org = await createOrganization(fixture.db, {
        slug: "sso-revisions",
        name: "SSO revisions",
      });
      expect(
        (await put(org.id, "bad", { "If-None-Match": "bad" })).status,
      ).toBe(400);
      expect(
        (await put(org.id, "both", { "If-Match": "*", "If-None-Match": "*" }))
          .status,
      ).toBe(400);
      const created = await put(org.id, "create", { "If-None-Match": "*" });
      expect(created.status).toBe(201);
      expect((await put(org.id, "missing", {})).status).toBe(200);
      const first = await created.json();
      const tag = created.headers.get("ETag")!;
      expect(tag).toBeString();
      expect((await read(org.id)).headers.get("ETag")).toBe(tag);
      expect(
        (await put(org.id, "create", { "If-None-Match": "*" })).headers.get(
          "Idempotency-Replayed",
        ),
      ).toBe("true");
      expect(
        (await put(org.id, "other-create", { "If-None-Match": "*" })).status,
      ).toBe(412);
      const changedInput = {
        ...input,
        oidc: { ...input.oidc, clientSecret: "replacement-secret" },
      };
      const changed = await put(
        org.id,
        "replace",
        { "If-Match": tag },
        changedInput,
      );
      expect(changed.status).toBe(200);
      const after = await changed.json();
      const currentTag = changed.headers.get("ETag")!;
      expect(after.revision).toBe(first.revision + 1);
      expect(JSON.stringify(after)).not.toContain("replacement-secret");
      expect((await put(org.id, "stale", { "If-Match": tag })).status).toBe(
        412,
      );
      expect(
        (await put(org.id, "weak", { "If-Match": `W/${currentTag}` })).status,
      ).toBe(400);
      const replay = await put(
        org.id,
        "replace",
        { "If-Match": tag },
        changedInput,
      );
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      await expectReceipt(fixture.db, replay);
      const noop = await put(
        org.id,
        "noop",
        { "If-Match": currentTag },
        changedInput,
      );
      expect(noop.status).toBe(200);
      expect(await noop.json()).toEqual(after);
      expect(
        (await put(org.id, "replace", { "If-Match": currentTag }, changedInput))
          .status,
      ).toBe(409);
      await expect(
        fixture.db
          .update(ssoProviders)
          .set({ revision: 1 })
          .where(eq(ssoProviders.id, first.id))
          .execute(),
      ).rejects.toThrow();
      const removed = await fixture.app.request(
        `/api/admin/v1/organizations/${org.id}/sso-provider`,
        { method: "DELETE", headers: fixture.headers("platformAdmin") },
      );
      expect(removed.status).toBe(204);
      expect(
        (await put(org.id, "gone", { "If-Match": currentTag })).status,
      ).toBe(412);
      const recreated = await put(org.id, "recreate", { "If-None-Match": "*" });
      expect(recreated.status).toBe(201);
      const next = await recreated.json();
      expect(next.id).not.toBe(first.id);
      expect(
        (await put(org.id, "wrong-instance", { "If-Match": tag })).status,
      ).toBe(412);
      const nextTag = recreated.headers.get("ETag")!;
      const competing = await Promise.all([
        put(org.id, "race-a", { "If-Match": nextTag }, changedInput),
        put(
          org.id,
          "race-b",
          { "If-Match": nextTag },
          { ...input, domain: "changed.example.com" },
        ),
      ]);
      expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
      const beforeRaw = await read(org.id);
      const rawTag = beforeRaw.headers.get("ETag")!;
      await fixture.db.execute(
        sql`update sso_providers set oidc_config = oidc_config || ' ' where id = ${next.id}`,
      );
      expect((await read(org.id)).headers.get("ETag")).not.toBe(rawTag);
    },
  },
];
test.each(cases)("$name", async ({ run }) => {
  await run();
});
