import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { adminOperations } from "../db/schema/index.ts";

export async function expectReceipt(db: Database, response: Response) {
  const operationId = response.headers.get("Operation-Id");
  expect(operationId).toBeString();
  expect(response.headers.get("Idempotency-Replayed")).toBe("true");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("ETag")).toBeNull();
  const [receipt] = await db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, operationId!));
  expect(receipt).toBeDefined();
  expect(response.status).toBe(receipt!.statusCode);
  if (response.status === 204) expect(await response.text()).toBe("");
  else
    expect(await response.json()).toEqual({
      operationId,
      outcome: receipt!.outcome,
      statusCode: receipt!.statusCode,
      resultReference: receipt!.resultReference,
    });
}
