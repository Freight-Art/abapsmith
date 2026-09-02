/**
 * Element-level diff between a properties-shape write's SENT XML descriptor
 * and an independently re-read STORED one — proves only that the server kept
 * fewer non-empty leaf values than it was sent, never why. Reported case:
 * a `TTYP/DA` write carrying `<ttyp:rangeType>ZTMD_E_CARRID</ttyp:rangeType>`
 * whose read-back holds `<ttyp:rangeType/>` — `activated: true`,
 * no warning, the object-level etag check upstream sees only the PUT's own
 * echo and passes.
 *
 * A value that merely CHANGED (server normalisation, case-folding, `0` ->
 * `000000`) is not a discard: only the COUNT of non-empty occurrences per
 * element name is compared, never the text itself, because the server
 * routinely rewrites values it kept and flagging that would be noise on
 * every ordinary write.
 */

const XML_NOISE = /<\?xml[^?]*\?>|<!--[\s\S]*?-->/g;
const START_TAG = /<([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const END_TAG = /<\/([A-Za-z_][\w.-]*(?::[\w.-]+)?)\s*>/g;

/** One element name whose sent document held more non-empty text than the stored one. */
export interface DiscardedValue {
  /** Qualified element name exactly as it appears in the sent document, e.g. `ttyp:rangeType`. */
  readonly element: string;
  readonly sent: readonly string[];
  readonly stored: readonly string[];
}

/**
 * Non-empty trimmed text of every LEAF element, keyed by qualified name, in
 * first-seen order of first occurrence. A leaf is a start/end tag pair (or a
 * self-closing tag) whose content contains no `<` — `<a><b>x</b></a>` yields
 * only `b`, never `a`. Attributes are ignored entirely.
 */
function leafTexts(xml: string): Map<string, string[]> {
  const clean = xml.replace(XML_NOISE, "");
  const out = new Map<string, string[]>();
  const push = (name: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let list = out.get(name);
    if (!list) {
      list = [];
      out.set(name, list);
    }
    list.push(trimmed);
  };

  START_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = START_TAG.exec(clean)) !== null) {
    const name = m[1]!;
    const selfClosed = m[3] === "/";
    if (selfClosed) continue; // no text, nothing to lose
    const afterStart = START_TAG.lastIndex;
    END_TAG.lastIndex = afterStart;
    const end = END_TAG.exec(clean);
    if (!end || end[1] !== name) continue; // not a simple leaf pair — skip, don't guess
    const inner = clean.slice(afterStart, end.index);
    if (inner.includes("<")) continue; // has children — not a leaf
    push(name, inner);
    START_TAG.lastIndex = END_TAG.lastIndex;
  }
  return out;
}

/**
 * Compares what a write sent against what an independent read-back shows the
 * server kept. Reports an element only when the sent document has STRICTLY
 * MORE non-empty occurrences of it than the stored one — a value that
 * changed but stayed non-empty is not reported, deliberately: widening this
 * to flag every changed value would turn routine server normalisation into
 * false positives on writes that lost nothing.
 */
export function discardedDescriptorValues(sent: string, stored: string): DiscardedValue[] {
  const sentTexts = leafTexts(sent);
  const storedTexts = leafTexts(stored);
  const out: DiscardedValue[] = [];
  for (const [element, sentValues] of sentTexts) {
    const storedValues = storedTexts.get(element) ?? [];
    if (sentValues.length > storedValues.length) {
      out.push({ element, sent: sentValues, stored: storedValues });
    }
  }
  return out;
}
