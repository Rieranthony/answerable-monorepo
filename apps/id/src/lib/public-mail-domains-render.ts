/**
 * What `public-mail-domains.generated.ts` holds, one domain to a line so that a refresh is a
 * diff a person can read. Only the generator and its drift test use this.
 */
export function renderPublicMailDomains(
  domains: readonly string[],
  version: string,
) {
  return `// Generated from free-email-domains ${version}: bun run --filter @answerable/id public-mail:generate. Never edit it by hand.
export const publicMailDomains: readonly string[] = [
${domains.map((domain) => `  ${JSON.stringify(domain)},`).join("\n")}
];
`;
}
