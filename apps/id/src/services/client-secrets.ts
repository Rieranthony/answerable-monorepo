export function generateClientSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

export function hashClientSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("base64url");
}
