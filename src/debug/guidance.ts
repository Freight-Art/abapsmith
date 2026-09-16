/**
 * Note-once guidance for debugger responses (#151).
 *
 * Several debugger notes explain a SEMANTIC the caller only needs to read
 * once per session — what a revisited position does and does not prove, that
 * the frame read-cursor does not change what runs next, what an OMITTED or
 * UNREQUESTED variable row means, what a post-mortem attach is. Printed on
 * every stop they cost a stepping session of 20-40 calls several thousand
 * characters of text the caller has already read.
 *
 * A `GuidanceLedger` lives on the run (one per debug session) and decides,
 * per note KEY, whether to print the full explanation or a one-line brief:
 * the full text the first time the key is seen, the brief afterwards. A
 * state change the caller must re-read for (a breakpoint hit, a post-mortem
 * attach) re-arms the full text through `noteStateChange`, but only when the
 * signature differs from the previous one — hitting the same breakpoint
 * again in a loop does not re-print the explanation.
 *
 * The brief is never empty and always carries the per-call FACT (which ids,
 * which frame, how many visits); only the explanation of what the fact means
 * is elided. Per-call evidence that is not boilerplate (watchpoint values,
 * termination evidence, auto-continue reports) does not go through the ledger.
 */

export interface GuidanceNote {
  /** Identifies the explanation, not the occurrence — `"revisit"`, `"omitted"`, ... */
  key: string;
  /** Printed the first time `key` is seen since the last state change. */
  full: string;
  /** Printed every later time. Must still state the per-call fact. */
  brief: string;
}

export class GuidanceLedger {
  private readonly seen = new Set<string>();
  private lastSignature: string | undefined;

  /**
   * The text to emit for `notes`, in order: the full text for a key not yet
   * seen since the last state change, the brief otherwise. Marks each key
   * seen, so two notes with the same key in ONE call print full then brief.
   */
  render(notes: readonly GuidanceNote[]): string[] {
    const out: string[] = [];
    for (const note of notes) {
      if (this.seen.has(note.key)) {
        out.push(note.brief);
      } else {
        this.seen.add(note.key);
        out.push(note.full);
      }
    }
    return out;
  }

  /**
   * Record that the run's state changed in a way worth re-reading the full
   * notes for. `signature` names the change (`"bp:<ids>"`, `"postmortem"`);
   * only a signature DIFFERENT from the previous one re-arms the full text.
   */
  noteStateChange(signature: string): void {
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.seen.clear();
  }

  /** True when `key` has already been printed in full since the last state change. */
  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }
}

/** Characters `buildResponse` adds around each note (`"NOTE: "` plus the joining newline). */
const NOTE_OVERHEAD = "NOTE: ".length + 1;

/**
 * The char budget a response may use once its notes ride OUTSIDE it (#151):
 * the caller's clamped budget plus what the rendered notes occupy, so a
 * note never displaces variable content. `buildResponse` still clamps the
 * whole text to the value it is given, so the notes' own length is the only
 * excess this admits.
 */
export function budgetWithNotes(notes: readonly string[], clampedMaxChars: number): number {
  return clampedMaxChars + notes.reduce((sum, n) => sum + n.length + NOTE_OVERHEAD, 0);
}
