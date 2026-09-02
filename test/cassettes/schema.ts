/**
 * Cassette schema.
 *
 * A "cassette" is a JSON file recording ONE real HTTP exchange genuinely
 * captured against the live A4H SAP sandbox appliance: the exact request
 * that was sent and the exact response that came back over the wire. This
 * schema is the single source of truth for that file's shape; every
 * `.cassette.json` under `test/cassettes/` must validate against
 * `CassetteSchema`.
 *
 * This exists to replace hand-authored fixtures for `test/helpers/fake-adt.ts`
 * with fixtures that trace to real bytes — see `test/cassettes/README.md` for
 * the full rationale ("do not fabricate cassette content").
 */
import { z } from "zod";

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/**
 * Where this cassette's bytes came from.
 *
 * - `live-capture-raw`: transcribed directly from a `*.meta.json` +
 *   body-file pair under `test/fixtures/live-captured/` (or an equivalent
 *   raw capture artifact) — the primary source IS the wire capture.
 * - `live-capture-transcribed`: transcribed from a human-readable rendering
 *   of a raw capture embedded in prose documentation (e.g. a fenced code
 *   block in a doc file that itself cites a raw `.jsonl` capture
 *   file). One remove further from the wire than `live-capture-raw`, which
 *   is exactly why the distinction exists — a reader auditing provenance
 *   should be able to tell the two apart without opening `citation`.
 */
export const CassetteSourceTypeSchema = z.enum(["live-capture-raw", "live-capture-transcribed"]);

export const CassetteSourceSchema = z.object({
  type: CassetteSourceTypeSchema,
  /** Exact path(s) to the primary source file(s), or a doc section citation. */
  citation: z.string().min(1),
  /**
   * Free-text provenance notes: redaction decisions, discrepancies between
   * a filename and its actual content, anything a reader needs in order to
   * trust (or correctly distrust) this cassette. May be empty when there is
   * nothing to add beyond `citation`.
   */
  notes: z.string(),
});
export type CassetteSource = z.infer<typeof CassetteSourceSchema>;

/**
 * Appliance identity/build info at capture time. A4H is an expendable,
 * periodically-rebuilt sandbox (see `STALENESS_WINDOW_DAYS` below) — kernel
 * and patch level can change across rebuilds, so this is recorded per
 * cassette rather than assumed constant.
 */
export const CassetteApplianceSchema = z.object({
  sid: z.string(),
  client: z.string(),
  kernelRelease: z.string().optional(),
  kernelPatchLevel: z.string().optional(),
  server: z.string().optional(),
});
export type CassetteAppliance = z.infer<typeof CassetteApplianceSchema>;

const CassetteMessageSchema = z.object({
  headers: z.record(z.string(), z.string()),
  /** `null` for an empty/absent body (e.g. GET requests, 0-byte responses). */
  body: z.string().nullable(),
});

export const CassetteRequestSchema = z
  .object({
    method: HttpMethodSchema,
    /** Path + query string only — no scheme/host. e.g. `/sap/bc/adt/debugger/breakpoints`. */
    path: z.string().min(1),
  })
  .extend(CassetteMessageSchema.shape);
export type CassetteRequest = z.infer<typeof CassetteRequestSchema>;

export const CassetteResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
  })
  .extend(CassetteMessageSchema.shape);
export type CassetteResponse = z.infer<typeof CassetteResponseSchema>;

export const CassetteSchema = z.object({
  /** Must equal the file's slug (the `<slug>` in `<slug>.cassette.json`). */
  id: z.string().min(1),
  /** ISO 8601 timestamp with an explicit offset, from the capture harness. */
  recordedAt: z.string().datetime({ offset: true }),
  /**
   * Wall-clock duration of the real exchange, when known — genuinely
   * meaningful for long-poll captures (e.g. a listener that blocked for
   * several seconds waiting for a debuggee to hit a breakpoint).
   */
  recordedDurationMs: z.number().nonnegative().optional(),
  appliance: CassetteApplianceSchema,
  source: CassetteSourceSchema,
  request: CassetteRequestSchema,
  response: CassetteResponseSchema,
});
export type Cassette = z.infer<typeof CassetteSchema>;
