/**
 * Multi-system configuration.
 *
 * A single-system deployment configures abapsmith entirely through
 * `ABAP_*` environment variables (`src/config.ts`'s `loadConfig`). This
 * module is the layer above that: it lets one abapsmith process serve
 * SEVERAL SAP systems, each identified by a short alias the caller names
 * as the `system` tool parameter, by producing one fully-validated
 * `Config` per alias — the same `Config` shape a single-system server
 * gets, built by literally calling `loadConfig` once per system against an
 * overlaid environment.
 *
 * Two sources feed the alias table, and either or both may be used:
 *
 *  1. `ABAP_SYSTEMS` — a path to a JSON file (or inline JSON, when the
 *     trimmed value starts with `{`) describing every system in one place.
 *     Convenient for a fleet of systems managed together, and reviewable
 *     as a single file. Secrets may NOT sit in this file — see
 *     `password_env`/`secrets` below.
 *
 *  2. `ABAP_SYSTEM_<ALIAS>_<SETTING>` — the `.env`-native form. Each
 *     variable sets one setting of one system, the same way `ABAP_URL`
 *     etc. do for a single-system deployment; `<SETTING>` maps directly to
 *     `ABAP_<SETTING>` in that alias's overlay. No file needed, and this
 *     is the only form real environment variables (as opposed to `.env`
 *     file contents) can express without inventing a second file format.
 *
 * Both sources may define the same alias; per the same rule `loadEnvFile`
 * already uses for `.env` vs. real environment variables, the
 * environment-variable form wins key by key when they disagree.
 *
 * What this module deliberately does NOT do: decide which system a given
 * tool call uses (that is the caller's dispatch logic), or hold any live
 * connection/pool state (each `SystemSpec.cfg` is inert configuration,
 * exactly like the `Config` a single-system server already carries).
 */
import { readFileSync } from "node:fs";

import { loadConfig, loadEnvFile, type Config } from "../config.js";

/** One fully-resolved, fully-validated system entry produced by {@link loadSystems}. */
export interface SystemSpec {
  /** Uppercase alias, `[A-Z0-9]{1,16}`. Also the value callers pass as the `system` tool parameter. */
  readonly alias: string;
  /** Fully parsed, fully validated config for this system — the same shape a single-system server gets. */
  readonly cfg: Config;
  /** Exactly one spec in a returned list has this true. */
  readonly isDefault: boolean;
  /**
   * The environment `cfg` was parsed from: the process environment with
   * this entry's overlay applied. Kept so per-system settings that are
   * read from an env map later (e.g. `journalConfigFromEnv`, which takes
   * a raw `NodeJS.ProcessEnv` rather than reading fields off `Config`) see
   * the same values `cfg` did, instead of falling back to the shared
   * process environment and silently losing the per-system override.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Where this entry came from, for startup messages: `file:<path>` or `env`. */
  readonly source: string;
}

export interface LoadSystemsOptions {
  env?: NodeJS.ProcessEnv;
  /** Where warnings go. Defaults to stderr — stdout is the MCP transport. */
  warn?: (msg: string) => void;
  /** Injected for tests — reads the systems file. Defaults to `readFileSync(path, "utf8")`. */
  readFile?: (path: string) => string;
  /** Passed through to `loadConfig`; also suppresses `loadEnvFile()` here. */
  skipDotenv?: boolean;
}

/**
 * The alias syntax rule, exported for tests and for the env-var form's
 * documentation: 1-16 uppercase letters/digits. No `_` — the alias is read
 * out of `ABAP_SYSTEM_<ALIAS>_<SETTING>` as the segment up to the FIRST
 * remaining underscore, so an alias containing one would be unparseable
 * (there would be no way to tell where the alias ends and the setting
 * name begins).
 */
export function isValidAlias(alias: string): boolean {
  return /^[A-Z0-9]{1,16}$/.test(alias);
}

/** File-entry key -> the `ABAP_*` env var it overlays. Covers every recognised key except `default`, `password_env`, `env` and `secrets`, which get their own handling. */
const FILE_KEY_TO_ENV_VAR: Readonly<Record<string, string>> = Object.freeze({
  url: "ABAP_URL",
  user: "ABAP_USER",
  client: "ABAP_CLIENT",
  sid: "ABAP_SID",
  mode: "ABAP_MODE",
  allow_packages: "ABAP_ALLOW_PACKAGES",
  allow_name_prefixes: "ABAP_ALLOW_NAME_PREFIXES",
  allow_transports: "ABAP_ALLOW_TRANSPORTS",
});

const RECOGNISED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_KEY_TO_ENV_VAR),
  "password_env",
  "default",
  "env",
  "secrets",
]);

/** Entry keys that would put a plaintext credential directly in the systems file. */
const SECRET_ENTRY_KEYS: ReadonlySet<string> = new Set(["password", "passwd", "pass"]);

/**
 * Names an `env` map key is never allowed to carry, regardless of the
 * `ABAP_` prefix check — these are the names a real secret rides under.
 * `secrets` (env-var-name indirection, not a value) is the escape hatch.
 */
const FORBIDDEN_ENV_NAME_RE = /PASSWORD|PASSPHRASE|SECRET|TOKEN|COOKIE/i;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Same truthiness rule `loadConfig`'s `boolFromEnv` uses, needed here before any `Config` exists to check against. */
function truthy(v: string): boolean {
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * `systems entry ALIAS (source): message` — the shape every per-entry
 * problem in the aggregated error uses, so a problem found while parsing
 * the file and a problem found while parsing an env var (or later, inside
 * `loadConfig` itself) all read the same way.
 */
function entryProblem(alias: string, source: string, message: string): string {
  return `systems entry ${alias} (${source}): ${message}`;
}

/**
 * One recognised file-entry value (a URL, a client, an allowlist, …) into
 * the string an env-var overlay needs. Arrays join with `,` (matching how
 * `ABAP_ALLOW_PACKAGES` etc. are already comma-separated lists); booleans
 * and numbers stringify; an object or `null` is rejected outright rather
 * than stringified into something like `"[object Object]"`.
 */
function fileValueToEnvString(value: unknown, what: string): { value: string } | { error: string } {
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      return { error: `${what} must be an array of strings.` };
    }
    return { value: value.join(",") };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { value: String(value) };
  }
  return {
    error: `${what} must be a string, number, boolean, or array of strings (got ${value === null ? "null" : typeof value}).`,
  };
}

/** Multi-line `loadConfig` failure text collapsed onto one line for a single aggregated bullet, e.g. "Invalid abapsmith configuration: url: ABAP_URL is required". */
function flattenMultilineError(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length <= 1) return message;
  const [first, ...rest] = lines;
  const bullets = rest.map((l) => l.replace(/^-\s*/, ""));
  return `${first} ${bullets.join("; ")}`;
}

/** Accumulated state for one alias while both sources are being read; folded into a `SystemSpec` (or a set of problems) once both passes finish. */
interface AliasBuild {
  /** `ABAP_*` overlay to apply on top of the shared base environment. */
  overlay: Record<string, string>;
  /** Whether ANY source has marked this alias default so far — later writes win, per-key, matching the merge rule. */
  defaultFlag: boolean;
  /** True once any `ABAP_SYSTEM_<ALIAS>_*` variable has touched this alias — decides the `source` label (env wins the description too, matching the merge rule). */
  fromEnv: boolean;
  fromFile: boolean;
}

/**
 * Resolves the multi-system configuration, if any, into one validated
 * `Config` per system.
 *
 * Returns `undefined` when neither `ABAP_SYSTEMS` nor any
 * `ABAP_SYSTEM_<ALIAS>_*` variable is present — the caller's cue to fall
 * back to plain single-system `loadConfig()`. Otherwise every problem
 * across every entry (malformed file, missing secret, an invalid
 * `loadConfig()` result for one alias, an ambiguous default, …) is
 * collected and thrown together as ONE aggregated `Error`, so a multi-system
 * deployment is validated in full at startup rather than failing one
 * system at a time across restarts.
 */
export function loadSystems(opts: LoadSystemsOptions = {}): readonly SystemSpec[] | undefined {
  // Same as loadConfig: a .env file can carry ABAP_SYSTEMS / ABAP_SYSTEM_*
  // just like it carries ABAP_URL. Must run BEFORE detection below — the
  // whole point is that ABAP_SYSTEMS/ABAP_SYSTEM_* may only exist because
  // of a .env file, not yet in process.env. Real environment variables
  // still win: loadEnvFile() never overwrites an already-set var.
  if (!opts.skipDotenv) loadEnvFile();

  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const rawAbapSystems = env.ABAP_SYSTEMS;
  const hasAbapSystems = rawAbapSystems !== undefined && rawAbapSystems.trim() !== "";
  const systemEnvVarNames = Object.keys(env)
    .filter((k) => k.startsWith("ABAP_SYSTEM_"))
    .sort();
  if (!hasAbapSystems && systemEnvVarNames.length === 0) return undefined;

  const problems: string[] = [];
  const builds = new Map<string, AliasBuild>();

  function getBuild(alias: string): AliasBuild {
    const existing = builds.get(alias);
    if (existing !== undefined) return existing;
    const created: AliasBuild = { overlay: {}, defaultFlag: false, fromEnv: false, fromFile: false };
    builds.set(alias, created);
    return created;
  }

  // ---- Source 1: ABAP_SYSTEMS (file path or inline JSON) ----
  let fileSourceLabel: string | undefined;
  let fileTopDefault: string | undefined;
  if (rawAbapSystems !== undefined && rawAbapSystems.trim() !== "") {
    const trimmed = rawAbapSystems.trim();
    let json: unknown;
    if (trimmed.startsWith("{")) {
      fileSourceLabel = "file:<inline JSON>";
      try {
        json = JSON.parse(trimmed);
      } catch (e) {
        problems.push(`ABAP_SYSTEMS is inline JSON but could not be parsed: ${errMsg(e)}`);
      }
    } else {
      fileSourceLabel = `file:${trimmed}`;
      let text: string | undefined;
      try {
        text = readFile(trimmed);
      } catch (e) {
        problems.push(`ABAP_SYSTEMS names ${trimmed}, which could not be read: ${errMsg(e)}`);
      }
      if (text !== undefined) {
        try {
          json = JSON.parse(text);
        } catch (e) {
          problems.push(`ABAP_SYSTEMS file ${trimmed} is not valid JSON: ${errMsg(e)}`);
        }
      }
    }

    if (json !== undefined) {
      if (!isPlainObject(json)) {
        problems.push(`${fileSourceLabel}: top-level JSON must be an object with a "systems" key.`);
      } else {
        for (const key of Object.keys(json)) {
          if (key !== "default" && key !== "systems") {
            problems.push(
              `${fileSourceLabel}: unrecognised top-level key "${key}" — only "default" and "systems" are recognised.`,
            );
          }
        }

        const rawDefault = json.default;
        if (rawDefault !== undefined) {
          if (typeof rawDefault !== "string" || rawDefault.trim() === "") {
            problems.push(`${fileSourceLabel}: "default" must be a non-empty string naming a system alias.`);
          } else {
            fileTopDefault = rawDefault;
          }
        }

        const rawSystems = json.systems;
        if (!isPlainObject(rawSystems) || Object.keys(rawSystems).length === 0) {
          problems.push(`${fileSourceLabel}: "systems" must be a non-empty object mapping alias to system settings.`);
        } else {
          for (const [rawAlias, rawEntry] of Object.entries(rawSystems)) {
            if (!isPlainObject(rawEntry)) {
              problems.push(`${fileSourceLabel}: systems entry "${rawAlias}" must be an object.`);
              continue;
            }
            if (!isValidAlias(rawAlias)) {
              problems.push(
                `${fileSourceLabel}: systems entry "${rawAlias}": alias is invalid — expected 1-16 uppercase ` +
                  "letters or digits (A-Z, 0-9), e.g. \"DEV\".",
              );
              continue;
            }
            const alias = rawAlias;
            const build = getBuild(alias);
            build.fromFile = true;

            for (const [key, value] of Object.entries(rawEntry)) {
              if (SECRET_ENTRY_KEYS.has(key.toLowerCase())) {
                problems.push(
                  entryProblem(
                    alias,
                    fileSourceLabel,
                    `"${key}" would put a secret in this file — use "password_env" (or "secrets") to ` +
                      "name an environment variable instead.",
                  ),
                );
                continue;
              }
              if (!RECOGNISED_ENTRY_KEYS.has(key)) {
                problems.push(entryProblem(alias, fileSourceLabel, `unrecognised key "${key}".`));
                continue;
              }

              if (key === "default") {
                if (typeof value !== "boolean") {
                  problems.push(entryProblem(alias, fileSourceLabel, '"default" must be true or false.'));
                } else if (value) {
                  build.defaultFlag = true;
                }
                continue;
              }

              if (key === "password_env") {
                if (typeof value !== "string" || value.trim() === "") {
                  problems.push(
                    entryProblem(
                      alias,
                      fileSourceLabel,
                      '"password_env" must be a non-empty string naming an environment variable.',
                    ),
                  );
                  continue;
                }
                const resolved = env[value];
                if (resolved === undefined || resolved.trim() === "") {
                  problems.push(
                    entryProblem(alias, fileSourceLabel, `password_env names ${value}, which is not set in the environment.`),
                  );
                } else {
                  build.overlay.ABAP_PASSWORD = resolved;
                }
                continue;
              }

              if (key === "env") {
                if (!isPlainObject(value)) {
                  problems.push(
                    entryProblem(alias, fileSourceLabel, '"env" must be an object of ABAP_* environment overrides.'),
                  );
                  continue;
                }
                for (const [envKey, envVal] of Object.entries(value)) {
                  if (!envKey.startsWith("ABAP_")) {
                    problems.push(entryProblem(alias, fileSourceLabel, `"env" key "${envKey}" must start with ABAP_.`));
                    continue;
                  }
                  if (FORBIDDEN_ENV_NAME_RE.test(envKey)) {
                    problems.push(
                      entryProblem(
                        alias,
                        fileSourceLabel,
                        `"env.${envKey}" would put a secret in this file — use "secrets" to name an ` +
                          "environment variable holding the value instead.",
                      ),
                    );
                    continue;
                  }
                  const converted = fileValueToEnvString(envVal, `"env.${envKey}"`);
                  if ("error" in converted) {
                    problems.push(entryProblem(alias, fileSourceLabel, converted.error));
                  } else {
                    build.overlay[envKey] = converted.value;
                  }
                }
                continue;
              }

              if (key === "secrets") {
                if (!isPlainObject(value)) {
                  problems.push(
                    entryProblem(
                      alias,
                      fileSourceLabel,
                      '"secrets" must be an object mapping an ABAP_* variable name to the name of an ' +
                        "environment variable.",
                    ),
                  );
                  continue;
                }
                for (const [secretKey, secretVarName] of Object.entries(value)) {
                  if (!secretKey.startsWith("ABAP_")) {
                    problems.push(
                      entryProblem(alias, fileSourceLabel, `"secrets" key "${secretKey}" must start with ABAP_.`),
                    );
                    continue;
                  }
                  if (typeof secretVarName !== "string" || secretVarName.trim() === "") {
                    problems.push(
                      entryProblem(
                        alias,
                        fileSourceLabel,
                        `"secrets.${secretKey}" must be a non-empty string naming an environment variable.`,
                      ),
                    );
                    continue;
                  }
                  const resolved = env[secretVarName];
                  if (resolved === undefined || resolved.trim() === "") {
                    problems.push(
                      entryProblem(
                        alias,
                        fileSourceLabel,
                        `secrets.${secretKey} names ${secretVarName}, which is not set in the environment.`,
                      ),
                    );
                  } else {
                    build.overlay[secretKey] = resolved;
                  }
                }
                continue;
              }

              // Only url/user/client/sid/mode/allow_packages/allow_name_prefixes/allow_transports
              // reach here — every other recognised key returned above.
              const envVarName = FILE_KEY_TO_ENV_VAR[key];
              const converted = fileValueToEnvString(value, `"${key}"`);
              if ("error" in converted) {
                problems.push(entryProblem(alias, fileSourceLabel, converted.error));
              } else if (envVarName !== undefined) {
                build.overlay[envVarName] = converted.value;
              }
            }
          }
        }
      }
    }
  }

  // ---- Source 2: ABAP_SYSTEM_<ALIAS>_<SETTING> ----
  for (const varName of systemEnvVarNames) {
    const rest = varName.slice("ABAP_SYSTEM_".length);
    const underscoreIdx = rest.indexOf("_");
    if (underscoreIdx === -1) {
      problems.push(`${varName} has no setting name — expected ABAP_SYSTEM_<ALIAS>_<SETTING>.`);
      continue;
    }
    const alias = rest.slice(0, underscoreIdx);
    const setting = rest.slice(underscoreIdx + 1);
    if (!isValidAlias(alias)) {
      problems.push(
        `${varName}: "${alias}" is not a valid system alias — expected 1-16 uppercase letters or digits ` +
          "(A-Z, 0-9); an alias may not contain \"_\".",
      );
      continue;
    }
    const value = env[varName];
    if (value === undefined) continue; // varName came from Object.keys(env), so this never actually fires.

    const build = getBuild(alias);
    build.fromEnv = true;

    if (setting === "DEFAULT") {
      build.defaultFlag = truthy(value);
      continue;
    }
    if (setting === "PASSWORD_ENV") {
      if (value.trim() === "") {
        problems.push(entryProblem(alias, "env", `${varName} must name a non-empty environment variable.`));
        continue;
      }
      const resolved = env[value];
      if (resolved === undefined || resolved.trim() === "") {
        problems.push(entryProblem(alias, "env", `password_env names ${value}, which is not set in the environment.`));
      } else {
        build.overlay.ABAP_PASSWORD = resolved;
      }
      continue;
    }
    // A direct ABAP_SYSTEM_<ALIAS>_PASSWORD lands here (setting === "PASSWORD"),
    // and is fine — it's already an environment variable, and the
    // no-secrets-in-a-file rule above is about the FILE source only.
    build.overlay[`ABAP_${setting}`] = value;
  }

  const aliases = [...builds.keys()];

  // ---- Default selection ----
  let defaultAlias: string | undefined;
  if (aliases.length > 0) {
    if (fileTopDefault !== undefined && !aliases.includes(fileTopDefault)) {
      problems.push(`${fileSourceLabel ?? "ABAP_SYSTEMS"}: "default" names "${fileTopDefault}", which is not a defined system.`);
      fileTopDefault = undefined;
    }

    const markedAliases = [...builds.entries()].filter(([, b]) => b.defaultFlag).map(([a]) => a);

    if (fileTopDefault !== undefined && markedAliases.length > 0) {
      const agree = markedAliases.length === 1 && markedAliases[0] === fileTopDefault;
      if (agree) {
        defaultAlias = fileTopDefault;
      } else {
        problems.push(
          `default system is ambiguous: the top-level "default" names "${fileTopDefault}", but ` +
            `[${markedAliases.join(", ")}] ${markedAliases.length === 1 ? "is" : "are"} also marked default ` +
            "individually — use only one way to mark the default system.",
        );
      }
    } else if (fileTopDefault !== undefined) {
      defaultAlias = fileTopDefault;
    } else if (markedAliases.length === 1) {
      defaultAlias = markedAliases[0];
    } else if (markedAliases.length > 1) {
      problems.push(`more than one system is marked default: [${markedAliases.join(", ")}] — mark exactly one.`);
    } else if (aliases.length === 1) {
      defaultAlias = aliases[0];
    } else {
      problems.push(
        `no default system is marked and there is more than one system ` +
          `[${aliases.slice().sort().join(", ")}] — mark exactly one as default (top-level "default" in the ` +
          'systems file, "default": true on one entry, or ABAP_SYSTEM_<ALIAS>_DEFAULT=true).',
      );
    }
  } else if (problems.length === 0) {
    // Detection at the top of this function found ABAP_SYSTEMS or an
    // ABAP_SYSTEM_* var, but every entry was rejected before adding itself
    // to `builds` without leaving a problem behind — shouldn't happen given
    // the code above, but fail loudly rather than silently returning
    // `undefined` (which would contradict "a multi-system config is present").
    problems.push("ABAP_SYSTEMS / ABAP_SYSTEM_* is present, but no usable system entry was found in it.");
  }

  // ---- Per-alias Config ----
  // Every OTHER ABAP_* variable (ABAP_URL, ABAP_MODE, ABAP_MAX_SESSIONS, …)
  // stays in the base environment as a shared default for every system —
  // only the ABAP_SYSTEM_* namespace itself is stripped, so one alias's
  // settings can never leak into another alias's config, but a value common
  // to every system only has to be set once.
  const baseEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith("ABAP_SYSTEM_")) delete baseEnv[key];
  }

  const seenWarnings = new Set<string>();
  const dedupedWarn = (msg: string) => {
    if (seenWarnings.has(msg)) return;
    seenWarnings.add(msg);
    warn(msg);
  };

  const specs: SystemSpec[] = [];
  for (const alias of aliases) {
    const build = builds.get(alias);
    if (build === undefined) continue; // alias came from builds.keys(), so this never actually fires.
    const source = build.fromEnv ? "env" : (fileSourceLabel ?? "file:<unknown>");
    const entryEnv: NodeJS.ProcessEnv = { ...baseEnv, ...build.overlay };

    let cfg: Config | undefined;
    try {
      // opts.readFile is a systems-FILE reader (path -> string); loadConfig's
      // own `readFile` is a credential-file reader with a different
      // signature (path -> Buffer) — left at loadConfig's own default here.
      cfg = loadConfig({ env: entryEnv, skipDotenv: true, warn: dedupedWarn });
    } catch (e) {
      problems.push(entryProblem(alias, source, flattenMultilineError(errMsg(e))));
    }

    if (cfg !== undefined) {
      specs.push({ alias, cfg, isDefault: alias === defaultAlias, env: entryEnv, source });
    }
  }

  if (problems.length > 0) {
    const lines = problems.map((p) => `  - ${p}`);
    throw new Error(
      `Invalid abapsmith multi-system configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        `${lines.join("\n")}\n` +
        "Every entry is validated at startup; fix all of them before the server will start.",
    );
  }

  // Two aliases pointing at the same (sid, url, client) triple share a
  // journal directory (journalConfigFromEnv keys the journal path on SID
  // alone) — allowed, but worth a startup warning since it means undo
  // history from one alias is visible under the other.
  const seenSystems = new Map<string, string>();
  for (const spec of specs) {
    const key = `${spec.cfg.sid} ${spec.cfg.url} ${spec.cfg.client}`;
    const existing = seenSystems.get(key);
    if (existing !== undefined) {
      warn(
        `[abapsmith] WARNING: systems ${existing} and ${spec.alias} share the same sid/url/client ` +
          `(sid=${spec.cfg.sid}) — they will share a journal directory.`,
      );
    } else {
      seenSystems.set(key, spec.alias);
    }
  }

  specs.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0;
  });

  return Object.freeze(specs.map((s) => Object.freeze(s)));
}
