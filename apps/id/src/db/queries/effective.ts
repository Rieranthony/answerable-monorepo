import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export function isEffective(table: {
  validFrom: PgColumn;
  validUntil: PgColumn;
  status?: PgColumn;
}): SQL {
  const window = sql`(${table.validFrom} is null or ${table.validFrom} <= now()) and (${table.validUntil} is null or ${table.validUntil} > now())`;

  // Parenthesised so callers can negate or combine it without precedence
  // surprises (`not (a and b)`, `x or (a and b)`).
  return table.status
    ? sql`(${table.status} = 'active' and ${window})`
    : sql`(${window})`;
}
