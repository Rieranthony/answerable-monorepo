# Changelog

## 0.1.0

The read side of the admin MCP, for Answerable staff.

- Only members of the platform organisation get a tool; the server learns that organisation at start from ID's `GET /me` and refuses to start when its machine client belongs to another.
- Roles `team`, `admin` and `owner`, conferred by `answerable-team`, `answerable-admin` and `answerable-owner` on an entitlement to the admin MCP's resource with no client, read from ID's member access view once per request and never cached. ID not answering fails closed.
- `admin_whoami` for every platform member, and nine reads for `team` and above: `organisations_list`, `organisations_get`, `members_list`, `members_get`, `groups_list`, `access_list`, `audit_list`, `sso_test` and `staff_list`. They take ID's parameter names and answer ID's field names.
- Every call and refusal is evidence on the platform organisation's chain in `answerable_admin`; every ID call carries the execution id as `x-request-id`.
