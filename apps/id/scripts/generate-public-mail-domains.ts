// Writes src/lib/public-mail-domains.generated.ts from the pinned free-email-domains package.
import domains from "free-email-domains";
import { version } from "free-email-domains/package.json";

import { renderPublicMailDomains } from "../src/lib/public-mail-domains-render.ts";

const target = new URL(
  "../src/lib/public-mail-domains.generated.ts",
  import.meta.url,
);
await Bun.write(target, renderPublicMailDomains(domains, version));
console.log(
  `Wrote apps/id/src/lib/public-mail-domains.generated.ts: ${domains.length} domains from free-email-domains ${version}`,
);
