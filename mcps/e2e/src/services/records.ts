import { Database } from "bun:sqlite"
import { ToolError } from "@answerable/mcp-base"
import { createInput, deleteInput, recordSchema, type FixtureRecord } from "../contracts"
import { z } from "zod"

export type RecordActor = { organizationId: string; userId: string; resourceInstanceId: string }
type RecordRow = { id: string; organizationId: string; creatorId: string; title: string; createdAt: string }

export function createRecordStore(path: string) {
  const db = new Database(path, { create: true, strict: true })
  let closed = false
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, creatorId TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_tenant ON records(organizationId, createdAt, id);
    CREATE TABLE IF NOT EXISTS receipts (
      resource TEXT NOT NULL, tenant TEXT NOT NULL, subject TEXT NOT NULL,
      tool TEXT NOT NULL, operationKey TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(resource, tenant, subject, tool, operationKey)
    );
  `)
  function get(actor: RecordActor, id: string): FixtureRecord {
    const row = db.query<RecordRow, [string, string]>("SELECT * FROM records WHERE organizationId = ? AND id = ?").get(actor.organizationId, id)
    if (!row) throw new ToolError("record_not_found", "record_not_found: No accessible record exists")
    return recordSchema.parse(row)
  }
  function operation<T>(actor: RecordActor, tool: string, key: string, input: unknown, run: () => T): T {
    return db.transaction(() => {
      const params: [string, string, string, string, string] = [actor.resourceInstanceId, actor.organizationId, actor.userId, tool, key]
      const encoded = JSON.stringify(input)
      const existing = db.query<{ input: string; result: string }, typeof params>(
        "SELECT input, result FROM receipts WHERE resource = ? AND tenant = ? AND subject = ? AND tool = ? AND operationKey = ?",
      ).get(...params)
      if (existing) {
        if (existing.input !== encoded) throw new ToolError("operation_key_reused", "operation_key_reused: Use a new key for different input")
        return JSON.parse(existing.result) as T
      }
      const result = run()
      db.query("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?)").run(...params, encoded, JSON.stringify(result))
      return result
    }).immediate()
  }
  return {
    close: () => { if (!closed) { db.close(); closed = true } },
    get,
    list(actor: RecordActor) {
      return db.query<RecordRow, [string]>("SELECT * FROM records WHERE organizationId = ? ORDER BY createdAt, id LIMIT 100")
        .all(actor.organizationId).map(row => recordSchema.parse(row))
    },
    create(actor: RecordActor, raw: z.input<typeof createInput>) {
      const input = createInput.parse(raw)
      return operation(actor, "records_create", input.operationKey, input, () => {
        const record = {
          id: crypto.randomUUID(), organizationId: actor.organizationId, creatorId: actor.userId,
          title: input.title, createdAt: new Date().toISOString(),
        }
        db.query("INSERT INTO records VALUES (?, ?, ?, ?, ?)").run(record.id, record.organizationId, record.creatorId, record.title, record.createdAt)
        return record
      })
    },
    remove(actor: RecordActor, raw: z.input<typeof deleteInput>) {
      const input = deleteInput.parse(raw)
      return operation(actor, "records_delete", input.operationKey, input, () => {
        get(actor, input.recordId)
        db.query("DELETE FROM records WHERE organizationId = ? AND id = ?").run(actor.organizationId, input.recordId)
        return { deleted: true as const, id: input.recordId }
      })
    },
  }
}

export type RecordStore = ReturnType<typeof createRecordStore>
