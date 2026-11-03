import { publicMailDomains } from "./public-mail-domains.generated.ts";

const domains = new Set(publicMailDomains);

/**
 * Whether anyone can get an address at this domain, so that holding one proves nothing about
 * a firm. An exact match in any case: a subdomain of a listed domain is not listed. Checked
 * when a domain is added or enabled, at import and at every admission, so that a row older
 * than the list fails closed when the list grows.
 */
export function isPublicMailDomain(domain: string) {
  return domains.has(domain.trim().toLowerCase());
}
