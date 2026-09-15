# jobs — Background jobs (SM37)

An operator-installable fluid plugin covering the SM37 surface: list
background jobs, read a job's steps and log, read a finished step's
spool output, schedule an ABAP report as a job, and cancel one. Entry
class: `ZCL_ZMCP_X_JOBS`.

## Actions

| Action | Category | What it does |
|---|---|---|
| `list` | read | Lists background jobs from TBTCO matching a name pattern and optional user/status/date filters. |
| `show` | read | Reads one job's header, its steps, and its job log. |
| `spool` | read | Reads a job step's spool output. |
| `schedule` | mutate | Creates a single-step background job running one existing ABAP report. |
| `cancel` | mutate | Aborts a running job, or deletes a scheduled/released/ready one. |

### `list`

Arguments: `name` (job-name pattern, `*` any chars, `+` one char,
default `*`), `user` (only jobs scheduled by this user), `status`
(one of `P`/`S`/`Y`/`R`/`F`/`A`/`X`/`Z`), `from_date`/`to_date`
(`YYYYMMDD` window, compared against the actual start date, or the
scheduled start date when the job never started), `max_rows` (default
100, `0` means no limit).

Returns `count`, `truncated`, and `jobs` — one row per job with
`jobname`, `jobcount`, `status`/`status_text`, `scheduled_by`,
`exec_user`, `job_class`, `periodic`, the scheduled and actual
start/end date-times, `step_count` and `exec_server`.

### `show`

Arguments: `jobname` (required), `jobcount` (omit to take the most
recently scheduled job with this name), `log_lines` (default 200, `0`
means all), `log_head` (return the first `log_lines` lines instead of
the last).

A job that has never started (status `P`, or `S` before the scheduler picks
it up) has no job log yet; `show` then returns the header and steps with an
empty `log`.

Returns the job header (same fields as a `list` row), `step_count` and
`steps` (one row per TBTCP step: `step`, `program`, `variant`,
`exec_user`, `status`, `language`, `spool_id` — empty when the step
produced no spool output — and `external`, true when the step is an
external program rather than an ABAP report), and `log_count` /
`log_truncated` / `log` (one row per job-log line: `date`, `time`,
`type`, `msgid`, `msgno`, `text`).

### `spool`

Arguments: give `spool_id` directly, or `jobname` (with optional
`jobcount` and `step`) to resolve one from a job's steps; `first_line`
(default 1), `last_line` (omit for the end of the list), `max_lines`
(default 1000, `0` means no cap).

Returns `spool_id`, `jobname`, `jobcount`, `step`, `line_count`,
`truncated` and `lines` (the spool list, one string per line).

### `schedule`

Arguments: `jobname` and `program` (required; `program` must be an
existing executable ABAP report, `TRDIR-SUBC = '1'`), `variant` (must
already exist; the action creates none), `start_date`/`start_time`
(omit `start_date` for an immediate start), `job_class` (`A`/`B`/`C`,
default `C`), `hold` (leaves the job scheduled but not released).

Returns `jobname`, `jobcount`, `program`, `variant`, `job_class`,
`released`, `status`/`status_text`, `step_number`, `start_mode`
(`immediate`/`scheduled`/`hold`), `start_date`, `start_time` and
`exec_user`.

### `cancel`

Arguments: `jobname` and `jobcount` (required), `any_owner` (act on a
job scheduled by another user; still subject to SAP's own
authorisation check).

Returns `jobname`, `jobcount`, `mode` (`abort`/`delete`), `cancelled`,
`status_before`/`status_before_text` and `scheduled_by`.

## Enabling

Plugins load only when the MCP server starts. Set these in the
server's environment and restart it:

```
ABAP_FLUID_PLUGINS=<repo>/fluid-plugins
ABAP_ALLOW_FLUID_PLUGINS=1
ABAP_ALLOW_FLUID_CALL_FM=1
ABAP_ALLOW_FLUID_PLUGIN_MUTATE=1
```

`ABAP_ALLOW_FLUID_PLUGINS=1` together with `ABAP_FLUID_PLUGINS`
pointing at this directory's parent makes the plugin visible at all.

`ABAP_ALLOW_FLUID_CALL_FM=1` is required for the plugin to load at
all, because every action goes through function modules
(`BP_JOBLOG_READ`, `RSPO_RETURN_ABAP_SPOOLJOB`, `JOB_OPEN` /
`JOB_SUBMIT` / `JOB_CLOSE`, `BP_JOB_ABORT`, `BP_JOB_DELETE`). Without
it the loader refuses the whole plugin with `SAFETY_DENIED` and
`rule: "ABAP_ALLOW_FLUID_CALL_FM"`.

`ABAP_ALLOW_FLUID_PLUGIN_MUTATE=1` is needed only to *call* `schedule`
and `cancel`. The plugin still loads without it — it writes through
function modules, not Open SQL, so the mutate gate applies per action
at dispatch, not at load — and the three read actions work normally.

## Examples

```
abap_fluid(tool="jobs", action="list", args={"name": "Z*", "status": "F"})

abap_fluid(tool="jobs", action="show", args={"jobname": "ZDEMO_JOB"})

abap_fluid(tool="jobs", action="spool", args={"jobname": "ZDEMO_JOB"})

abap_fluid(tool="jobs", action="schedule",
  args={"jobname": "ZDEMO_JOB", "program": "ZDEMO_REPORT"},
  confirm="jobs.schedule")

abap_fluid(tool="jobs", action="cancel",
  args={"jobname": "ZDEMO_JOB", "jobcount": "12345678"},
  confirm="jobs.cancel")
```

## Notes

- **Gating.** `schedule` declares `targets: { "object": "/program" }`,
  so the safety gate judges the report the job will run as a
  repository object. Two consequences follow: a standard SAP-namespace
  report is refused by the object-name prefix rule unless
  `ABAP_ALLOW_NAME_PREFIXES=*`; and because the manifest carries no
  package for that target, a non-`*` `ABAP_ALLOW_PACKAGES` fails the
  target closed. Both are deliberate — this action makes a report run
  unattended, so it fails closed. `cancel` declares no `targets`: a
  background job is not a repository object and has no package, so
  there is nothing for the gate to judge; a job-name check against the
  customer-namespace rule would be the wrong shape of refusal. `cancel`
  is controlled by `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`, the
  `confirm="jobs.cancel"` echo, the plugin's own owner check, and SAP's
  `S_BTCH_*` authorisations.
- **Productive systems.** No separate check was added because the
  fluid API as a whole is already refused on a productive system and
  in read-only mode, so `schedule` cannot run there.
- **Ownership.** By default `cancel` acts only on jobs whose
  `TBTCO-SDLUNAME` or `TBTCO-AUTHCKNAM` is the calling user;
  `any_owner: true` lifts that check *in the plugin*. The plugin
  cannot see abapsmith's `ABAP_MODE`, so this is not mode-aware — SAP's
  own `S_BTCH_ADM` / `S_BTCH_JOB` authorisations are the real control
  and will still refuse a caller who lacks them.
- **Journalling.** Every `schedule` and `cancel` call is journalled as
  an irreversible mutate with the action's input arguments. `cancel`
  therefore records both the job name and the job count. `schedule`'s
  job count is generated by `JOB_OPEN` and so appears only in the
  response, not in the journal entry, because the journal records a
  call's inputs and not its output; the journal entry names the job
  and the report.
- **No OS commands or external programs.** `schedule` has no argument
  for one, calls `JOB_SUBMIT` without `COMMANDNAME`,
  `OPERATINGSYSTEM` or any `EXTPGM_*` parameter, and refuses any
  program whose `TRDIR-SUBC` is not `'1'`. The class contains no
  `SUBMIT` statement at all; the fluid static review refuses `SUBMIT
  … VIA JOB` outright.
- **Cross-client tables.** `TBTCO` is cross-client (its client lives
  in the non-key field `AUTHCKMAN`), so every read filters
  `authckman = sy-mandt` and `BP_JOBLOG_READ` is called with `client =
  sy-mandt`. `TBTCP` has no client field at all, so its rows are
  reached only through an already client-scoped `TBTCO` row.
- **Commit handling.** The plugin never commits. `BP_JOB_DELETE` is
  called with `commitmode = space` instead of its own default `'X'`,
  so the fluid runtime's `COMMIT WORK AND WAIT` on success and
  `ROLLBACK WORK` on error stay in charge.
- **Truncation.** `list` caps at `max_rows` (default 100) and sets
  `truncated`; `show` caps the job log at `log_lines` (default 200,
  tail by default, head with `log_head`) and sets `log_truncated`;
  `spool` caps at `max_lines` (default 1000) and sets `truncated`.
  Truncation is always reported, never silent.
- **Status codes.** The DDIC domain behind `TBTCO-STATUS` carries no
  fixed values, so the status texts are a hand-maintained map (`P`
  scheduled, `S` released, `Y` ready, `R` active, `F` finished, `A`
  cancelled, `X` unknown, `Z` released/suspended). An unrecognised code
  comes back as the raw letter with an empty `status_text` rather than
  a guess.
- **Errors** come back as `FLUID_ACTION_FAILED` with `kind`, `step`,
  `subrc`, `msgid`, `msgno`, `text` describing where the call failed;
  a function-module failure names the exception and carries the SAP
  message.
- **Verify:** `abap_fluid(op="list")` shows `jobs` (or, if refused,
  the reason); `abap_fluid(op="describe", tool="jobs")` shows the
  schemas above; `abap_fluid(op="verify", tool="jobs")` shows what is
  actually deployed on the system.
