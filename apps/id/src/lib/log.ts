/**
 * Write one operational line to stderr: `[id] <area>`, then JSON that starts
 * with the level and the event. Fields carry identifiers, counts and codes;
 * never an error message, which can hold query parameters and credentials.
 */
export function logEvent(
  area: string,
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.error(
    `[id] ${area}`,
    JSON.stringify({ level: "error", event, ...fields }),
  );
}
