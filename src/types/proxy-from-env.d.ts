/**
 * `proxy-from-env` (used by `src/debug/proxy.ts` and, transitively, axios for
 * the ADT path) ships no bundled types and has no `@types/proxy-from-env`
 * package. Minimal ambient declaration for the one export this repo calls —
 * see `node_modules/proxy-from-env/index.js` for the real (JS) source this
 * mirrors.
 */
declare module "proxy-from-env" {
  export function getProxyForUrl(url: string): string;
}
