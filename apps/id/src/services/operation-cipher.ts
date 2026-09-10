import { CompactEncrypt, compactDecrypt } from "jose";
import { createHmac, timingSafeEqual } from "node:crypto";

export type OperationJson =
  | null
  | boolean
  | number
  | string
  | OperationJson[]
  | { [key: string]: OperationJson };

/** Dedicated deployment keys; never derive replay encryption from an auth secret. */
export function createOperationCipher(config: {
  activeKeyId: string;
  keys: Record<string, string>;
}) {
  const keys = new Map(
    Object.entries(config.keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, "base64url");
      if (!id || key.length !== 32 || key.toString("base64url") !== encoded)
        throw new Error(
          "Replay keys must be canonical base64url-encoded 256-bit keys",
        );
      return [id, key];
    }),
  );
  const active = keys.get(config.activeKeyId);
  if (!active) throw new Error("Active replay key is missing");
  // Separate the MAC key from the AES key while retaining one deployment key ring.
  const mac = (key: Buffer, input: string) =>
    createHmac(
      "sha256",
      createHmac("sha256", key)
        .update("answerable:id:operation-fingerprint:v1")
        .digest(),
    )
      .update(input)
      .digest();
  return {
    fingerprint(input: string) {
      return `hmac-v1.${Buffer.from(config.activeKeyId).toString("base64url")}.${mac(active, input).toString("hex")}`;
    },
    matchesFingerprint(input: string, fingerprint: string) {
      const match = /^hmac-v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(
        fingerprint,
      );
      if (!match) throw new Error("Invalid operation fingerprint");
      const keyId = Buffer.from(match[1]!, "base64url").toString();
      const key = keys.get(keyId);
      if (!key || Buffer.from(keyId).toString("base64url") !== match[1])
        throw new Error("Operation fingerprint key is unavailable");
      return timingSafeEqual(mac(key, input), Buffer.from(match[2]!, "hex"));
    },
    async encrypt(operationId: string, body: OperationJson) {
      const plaintext = new TextEncoder().encode(
        JSON.stringify(body, (_key, value: unknown) => {
          if (typeof value === "number" && !Number.isFinite(value))
            throw new Error("Operation response must be finite JSON");
          return value;
        }),
      );
      if (plaintext.byteLength > 1_048_576)
        throw new Error("Operation response is too large");
      return new CompactEncrypt(plaintext)
        .setProtectedHeader({
          alg: "dir",
          enc: "A256GCM",
          kid: config.activeKeyId,
          operationId,
        })
        .encrypt(active);
    },
    async decrypt(
      operationId: string,
      ciphertext: string,
    ): Promise<OperationJson> {
      const { plaintext, protectedHeader } = await compactDecrypt(
        ciphertext,
        (header) => {
          const key = keys.get(header.kid!);
          if (!key) throw new Error("Replay decryption key is unavailable");
          return key;
        },
        {
          keyManagementAlgorithms: ["dir"],
          contentEncryptionAlgorithms: ["A256GCM"],
        },
      );
      if (protectedHeader.operationId !== operationId)
        throw new Error("Replay ciphertext belongs to another operation");
      return JSON.parse(new TextDecoder().decode(plaintext));
    },
  };
}
export type OperationCipher = ReturnType<typeof createOperationCipher>;
