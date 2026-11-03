import { expect, test } from "bun:test";

import { magicLinkDrainDeadlineMs } from "./magic-link-requests.ts";

const read = (path: string) =>
  Bun.file(new URL(`../../../../${path}`, import.meta.url)).text();

test("the drain's deadline fits what SIGTERM leaves, and outlasts one send", async () => {
  const pods = await read("charts/answerable/templates/_server.tpl");
  const grace = Number(/terminationGracePeriodSeconds: (\d+)/.exec(pods)![1]);
  const preStop = Number(/command: \["sleep", "(\d+)"\]/.exec(pods)![1]);
  const transport = await read("packages/emails/src/transport.ts");
  const timeout = Number(
    /timeoutMs = ([\d_]+),/.exec(transport)![1]!.replace("_", ""),
  );
  const retryDelay = Number(
    /retryDelayMs = ([\d_]+),/.exec(transport)![1]!.replace("_", ""),
  );
  const send = timeout + retryDelay + timeout;

  expect(grace).toBe(30);
  expect(preStop).toBe(5);
  expect(send).toBe(21_000);
  expect(magicLinkDrainDeadlineMs).toBeGreaterThanOrEqual(send);
  // What stopping the server, the sweep and the pool have left.
  expect(
    (grace - preStop) * 1_000 - magicLinkDrainDeadlineMs,
  ).toBeGreaterThanOrEqual(3_000);
});
