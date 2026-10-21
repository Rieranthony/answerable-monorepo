// The admin MCP's database: the tables every server with a database has, and no others. One drizzle journal covers them (drizzle.config.ts).
export { evidenceEvents, evidencePayloads, intents } from "@answerable/mcp-postgres/schema"
