import type { Pool } from "pg";

/** Control statement time on this test pool. SQL, locks and transactions still run
 * in PostgreSQL; compiled policies/triggers retain their native database clock. */
export function databaseClock(pool: Pool) {
  let time: Date | undefined;
  pool.on("connect", (client) => {
    const query = client.query;
    client.query = function (this: typeof client, ...args: unknown[]) {
      const replace = (text: string) =>
        time
          ? text.replaceAll(
              "statement_timestamp()",
              `'${time.toISOString()}'::timestamptz`,
            )
          : text;
      const first = args[0];
      if (typeof first === "string") args[0] = replace(first);
      else if (
        first &&
        typeof first === "object" &&
        "text" in first &&
        typeof first.text === "string"
      )
        args[0] = { ...first, text: replace(first.text) };
      return Reflect.apply(query, this, args);
    } as typeof client.query;
  });
  return {
    set: (value: Date) => {
      time = value;
    },
  };
}
