/**
 * The five mutually exclusive ways this server can authenticate to an ABAP
 * system. Lives in its own module so the transport layer
 * (`src/adt/http-guard.ts`, `src/adt/connect-failure.ts`) can name a method
 * without importing `src/config.ts`, which would be a cycle.
 */
export type AuthMethod = "password" | "cookie" | "certificate" | "token" | "oauth";
