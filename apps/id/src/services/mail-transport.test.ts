import { describe, expect, spyOn, test } from "bun:test";

import { testEnvironment } from "../__tests__/support.ts";
import { capturingLogs } from "../__tests__/magic-link-requests.ts";
import { createMailTransport } from "./mail-transport.ts";

const message = {
  to: "person@firm.example.com",
  subject: "Sign in to Acme",
  html: "<p>html</p>",
  text: "the text, with a link",
  tag: "sign-in",
};

describe("which transport", () => {
  test("a token: Postmark, with the sender settings, and nothing else reaches the network", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({
        ErrorCode: 0,
        MessageID: "postmark-id",
      })) as unknown as typeof fetch);
    try {
      const transport = createMailTransport(
        testEnvironment({
          nodeEnv: "production",
          postmarkServerToken: "the-server-token",
          mailFrom: "ID <sign-in@id.example.com>",
          mailReplyTo: "help@example.com",
          mailSubjectPrefix: "[staging]",
        }),
      );
      expect(await transport.send(message)).toEqual({
        status: "sent",
        messageId: "postmark-id",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]! as unknown as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toBe("https://api.postmarkapp.com/email");
      expect(init.headers["X-Postmark-Server-Token"]).toBe("the-server-token");
      expect(JSON.parse(init.body as string)).toMatchObject({
        From: "ID <sign-in@id.example.com>",
        ReplyTo: "help@example.com",
        To: message.to,
        Subject: "[staging] Sign in to Acme",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("no token outside production: a line on standard output, which is the point, and no warning", async () => {
    for (const nodeEnv of ["development", "test"] as const) {
      const lines = await capturingLogs(async (lines) => {
        const transport = createMailTransport(testEnvironment({ nodeEnv }));
        expect(await transport.send(message)).toEqual({
          status: "sent",
          messageId: "local",
        });
        return lines;
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(message.to);
      expect(lines[0]).toContain(message.text);
    }
  });

  test("no token in production: one warning at startup, and every send fails without a word", async () => {
    const lines = await capturingLogs(async (lines) => {
      const transport = createMailTransport(
        testEnvironment({ nodeEnv: "production" }),
      );
      expect(lines).toEqual([
        `[id] mail ${JSON.stringify({ level: "error", event: "postmark_server_token_missing" })}`,
      ]);
      for (let send = 0; send < 3; send++)
        expect(await transport.send(message)).toEqual({
          status: "failed",
          httpStatus: null,
          errorCode: null,
          retried: false,
        });
      return lines;
    });
    expect(lines).toHaveLength(1);
  });
});
