import { timingSafeEqual } from "node:crypto";

export function secretMatches(expected: string, candidate: string): boolean {
  return timingSafeEqual(
    new Bun.CryptoHasher("sha256").update(expected).digest(),
    new Bun.CryptoHasher("sha256").update(candidate).digest(),
  );
}
