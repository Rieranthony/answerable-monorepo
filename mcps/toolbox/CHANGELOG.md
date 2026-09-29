# Changelog

## 0.2.0

Toolbox administration: the platform-tier admin API and the operation that enables an organisation.

- `/admin/v1`, served by the same `fetch` as the MCP endpoint: `GET /providers`, `GET` and `PUT` an organisation's catalogue entry, `POST /organisations/{id}/enable`, host clients (`GET`, `PUT`, `DELETE`) and `GET /organisations/{id}/evidence/verify`. It answers `{ error: { code, message } }` and needs a machine client's token for the admin resource, `toolboxAdminResource(TOOLBOX_RESOURCE_URL)` (the origin and `/admin`), with `toolbox:admin`; it needs `@answerable/auth` 0.3.0. A person's token is refused with `401`. There is no new variable.
- The enable operation reads what ID holds, stops on a row that does not fit, then makes what is missing: the Toolbox resource's allowed scopes (a union, never a replacement), each host client's link, the organisation's login and `toolbox` capabilities and entitlements, and the catalogue rows. Repeating it changes nothing. The Toolbox's machine client needs `platform:write` besides `platform:read`; the enable operation uses a token of its own for both, and reads still use `platform:read` alone.
- `createIdAdmin` gains `manage`, and every failure of ID's admin API or token endpoint is an `IdError` with the status and ID's problem code (status 0 when ID did not answer).
- `ingest` appends the identities of capabilities a provider never had before to `overrides.disabled` of every organisation that has the provider enabled (`Q-TOOLBOX-NEW-CAPABILITIES`: off until enabled).
- Migration `0003_host_clients.sql`: `host_clients` (`client_id`, `projection`, `direct_limit`), written by the admin API.
- `@answerable/mcp-toolbox/admin` exports `toolboxAdminResource`.

## 0.1.0

The core: one MCP endpoint that mounts providers, reads each caller's grant strings from ID, projects the granted capabilities directly, and records evidence and spans for every call.
