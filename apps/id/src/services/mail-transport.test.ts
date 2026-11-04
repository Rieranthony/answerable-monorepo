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
  test("a token: Postmark, from ID's address with the fixed reply address, and nothing else reaches the network", async () => {
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
          mailFromAddress: "sign-in@id.example.com",
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
        From: "Answerable ID <sign-in@id.example.com>",
        ReplyTo: "support@answerable.org",
        To: message.to,
        Subject: "Sign in to Acme",
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

  test("a token and POSTMARK_API_URL: the same call, to that URL, with the token in the header", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({
        ErrorCode: 0,
        MessageID: "fake-id",
      })) as unknown as typeof fetch);
    try {
      const transport = createMailTransport(
        testEnvironment({
          nodeEnv: "production",
          postmarkServerToken: "the-server-token",
          postmarkApiUrl: "https://postmark.stack.test:47712/email",
        }),
      );
      expect(await transport.send(message)).toEqual({
        status: "sent",
        messageId: "fake-id",
      });
      const [url, init] = fetchSpy.mock.calls[0]! as unknown as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toBe("https://postmark.stack.test:47712/email");
      expect(init.headers["X-Postmark-Server-Token"]).toBe("the-server-token");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("no token in production is a mistake that is refused, so a production process never prints a working link", () => {
    expect(() =>
      createMailTransport(testEnvironment({ nodeEnv: "production" })),
    ).toThrow("POSTMARK_SERVER_TOKEN is required in production");
  });
});
