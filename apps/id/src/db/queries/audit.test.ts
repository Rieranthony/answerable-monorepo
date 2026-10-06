import { expect, test } from "bun:test";
import { auditActions } from "./audit.ts";

const schemaDocument = new URL(
  "../../../../../docs/04-answerable-id-schema.md",
  import.meta.url,
);

test("the schema document describes every audit action ID writes, and no other", async () => {
  const text = await Bun.file(schemaDocument).text();
  const section = text.split("### Audit actions")[1]!.split("\n#")[0]!;
  const documented = section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) =>
      [...line.split("|")[1]!.matchAll(/`([a-z_.]+)`/g)].map(
        (match) => match[1]!,
      ),
    );
  expect(documented.length).toBe(new Set(documented).size);
  expect(documented.sort()).toEqual([...auditActions].sort());
});
