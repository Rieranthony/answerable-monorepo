import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { sql } from "drizzle-orm";

import { testEnvironment } from "../__tests__/support.ts";
import { testDatabaseUrl } from "../__tests__/test-database.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";

/**
 * A TCP proxy between the pool and the test database. `cut` destroys every socket with no word
 * from the server, as a crash, a node's loss or a network reset does. `pg_terminate_backend`
 * sends a FATAL first, which takes another path through `pg`, so it would prove nothing here.
 */
async function connectionCutter() {
  const { hostname, port } = new URL(testDatabaseUrl);
  const sockets = new Set<Socket>();
  const held = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // The other end going first is what a cut is.
    socket.on("error", () => {});
    return socket;
  };
  const server = createServer((client) => {
    held(client)
      .pipe(held(createConnection(Number(port), hostname)))
      .pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(testDatabaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    cut() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      this.cut();
      server.close();
    },
  };
}

const until = async (holds: () => boolean) => {
  for (let wait = 0; wait < 500 && !holds(); wait++) await Bun.sleep(10);
  expect(holds()).toBe(true);
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function open() {
  const cutter = await connectionCutter();
  const connection: DatabaseConnection = createDatabase(
    testEnvironment({ databaseUrl: cutter.url, databasePoolMax: 2 }),
  );
  const log = spyOn(console, "error").mockImplementation(() => {});
  cleanup = async () => {
    log.mockRestore();
    await connection.close();
    cutter.close();
  };
  return { cutter, connection, log };
}

const lostLine = [
  "[id] database",
  JSON.stringify({
    level: "error",
    event: "database_connection_lost",
    name: "Error",
  }),
];

test("an idle connection lost with no word from the server costs one log line, and the pool serves the next query", async () => {
  const { cutter, connection, log } = await open();
  const { db, pool } = connection;
  await db.execute(sql`select 1`);
  expect(pool.idleCount).toBe(1);
  cutter.cut();
  await until(() => pool.idleCount === 0);
  const { rows } = await db.execute(sql`select 1 as served`);
  expect(rows).toEqual([{ served: 1 }]);
  expect(log.mock.calls).toEqual([lostLine]);
});

test("a connection lost while a transaction holds it fails that transaction alone, and the pool serves the next query", async () => {
  const { cutter, connection, log } = await open();
  const { db, pool } = connection;
  const client = await pool.connect();
  try {
    await client.query("begin");
    cutter.cut();
    await until(() => log.mock.calls.length > 0);
    await expect(client.query("select 1")).rejects.toThrow();
  } finally {
    client.release();
  }
  const { rows } = await db.execute(sql`select 1 as served`);
  expect(rows).toEqual([{ served: 1 }]);
  expect(log.mock.calls).toEqual([lostLine]);
});

test("a drizzle transaction whose connection is lost rejects, and the next one works", async () => {
  const { cutter, connection, log } = await open();
  const { db } = connection;
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      cutter.cut();
      await until(() => log.mock.calls.length > 0);
      await tx.execute(sql`select 1`);
    }),
  ).rejects.toThrow();
  const answer = await db.transaction((tx) =>
    tx.execute(sql`select 1 as served`),
  );
  expect(answer.rows).toEqual([{ served: 1 }]);
});

test("the log line carries no message: a driver's error can hold credentials", async () => {
  const { cutter, connection, log } = await open();
  await connection.db.execute(sql`select 1`);
  cutter.cut();
  await until(() => log.mock.calls.length > 0);
  const written = JSON.stringify(log.mock.calls);
  expect(written).not.toContain("terminated");
  expect(written).not.toContain(new URL(testDatabaseUrl).password);
});
