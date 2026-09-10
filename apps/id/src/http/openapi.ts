import { withAdmissionResponse } from "./admission.ts";
import { generateSpecs } from "hono-openapi";

import type { App } from "../app.ts";
import type { Auth } from "../auth.ts";
import type { Environment } from "../env.ts";
import { publicAuthRoutes } from "./auth-allowlist.ts";
import { requestBoundaryResponses } from "./request-limits.ts";

type OpenApiOperation = {
  [key: string]: unknown;
  operationId?: string;
  summary?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
};

type OpenApiPathItem = {
  [key: string]: unknown;
  get?: OpenApiOperation;
  put?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  patch?: OpenApiOperation;
  trace?: OpenApiOperation;
};

type OpenApiComponents = {
  [key: string]: unknown;
  schemas?: Record<string, unknown>;
  securitySchemes?: Record<string, unknown>;
};

export type PublicOpenApiDocument = {
  openapi: "3.1.1";
  info: {
    title: "Answerable ID API";
    version: "0.0.0";
    description: string;
  };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  components: OpenApiComponents;
  paths: Record<string, OpenApiPathItem>;
};

const methodOrder = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

function sortPathItem(pathItem: OpenApiPathItem): OpenApiPathItem {
  const order = new Map<string, number>(
    methodOrder.map((method, index) => [method, index]),
  );

  return Object.fromEntries(
    Object.entries(pathItem).sort(([left], [right]) => {
      const leftOrder = order.get(left) ?? methodOrder.length;
      const rightOrder = order.get(right) ?? methodOrder.length;
      return leftOrder - rightOrder || left.localeCompare(right, "en");
    }),
  );
}

export async function buildPublicOpenApiDocument(input: {
  app: App;
  auth: Auth;
  environment: Environment;
  servers?: { url: string }[];
}): Promise<PublicOpenApiDocument> {
  const [honoDocument, authDocument] = await Promise.all([
    generateSpecs(input.app, {
      exclude: [
        /^\/openapi\.json$/,
        /^\/api\/admin\/openapi\.json$/,
        /^\/api\/admin\/docs$/,
        /^\/api\/admin\//,
      ],
    }),
    input.auth.api.generateOpenAPISchema(),
  ]);
  const routeByMethodAndPath = new Map(
    publicAuthRoutes.map((route) => [`${route.method} ${route.path}`, route]),
  );
  // The native generator includes fields hidden by its runtime response filter.
  const sessionSchema = authDocument.components.schemas.Session!;
  for (const [name, field] of Object.entries(
    input.auth.options.session.additionalFields,
  )) {
    if (field.returned === false) {
      delete sessionSchema.properties[name];
      sessionSchema.required = sessionSchema.required?.filter(
        (required) => required !== name,
      );
    }
  }
  const authPaths: Record<string, OpenApiPathItem> = {};

  for (const [authPath, pathItem] of Object.entries(authDocument.paths)) {
    const publicPath = `/auth${authPath}`;
    for (const [method, operation] of Object.entries(pathItem) as Array<
      [string, OpenApiOperation]
    >) {
      const route = routeByMethodAndPath.get(
        `${method.toUpperCase()} ${publicPath}`,
      );
      if (!route) continue;

      authPaths[publicPath] = {
        ...authPaths[publicPath],
        [method]: {
          ...operation,
          responses: {
            ...operation.responses,
            ...requestBoundaryResponses,
            503: withAdmissionResponse(
              operation.responses?.[503],
              "authentication",
            ),
          },
          operationId: route.operationId,
          summary: route.summary,
          tags: [route.tag],
          ...(route.security ? { security: route.security } : {}),
          ...(route.description !== undefined
            ? { description: route.description }
            : {}),
          ...(route.requestBody !== undefined
            ? { requestBody: route.requestBody }
            : {}),
        },
      };
    }
  }

  const components: OpenApiComponents = {
    ...honoDocument.components,
    ...authDocument.components,
    schemas: {
      ...honoDocument.components.schemas,
      ...authDocument.components.schemas,
    },
    securitySchemes: {
      ...honoDocument.components.securitySchemes,
      ...authDocument.components.securitySchemes,
    },
  };
  const unsortedPaths: Record<string, OpenApiPathItem> = {
    ...(honoDocument.paths as Record<string, OpenApiPathItem>),
    ...authPaths,
  };
  const paths = Object.fromEntries(
    Object.entries(unsortedPaths)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([path, pathItem]) => [path, sortPathItem(pathItem)]),
  );

  return {
    openapi: "3.1.1",
    info: {
      title: "Answerable ID API",
      version: "0.0.0",
      description:
        "The routes Answerable ID exposes today. Better Auth endpoints that are not listed here return 404.",
    },
    servers: input.servers ?? [{ url: input.environment.betterAuthUrl }],
    tags: [
      { name: "Token", description: "User authorisation and machine access" },
      {
        name: "Health",
        description: "Service liveness and readiness checks.",
      },
      {
        name: "Sign-in",
        description: "Start and complete authentication.",
      },
      {
        name: "Session",
        description: "Inspect and end the current session.",
      },
    ],
    components,
    paths,
  };
}
