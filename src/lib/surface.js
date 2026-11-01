/**
 * In-place rewind planning, and the client-side visibility input it produces.
 *
 * DSH appends to an immutable session log; the model-visible "surface" is an
 * ordered subset of that log. A rewind appends ONE `user/message` whose
 * `surfaceOp` replaces the target user message and every surface node after it,
 * so the next request derives its context from before the target. The log itself
 * is never modified — the rendered transcript and the audit view still hold
 * everything.
 *
 * These functions are pure: they take the committed events and the ordered
 * surface seqs and return a plan, so they are unit-testable without a session.
 */

/** Producer kind carried by every marker this plugin appends. */
export const MARKER_SOURCE_KIND = 'session-rewind';

/**
 * The constant marker body.
 *
 * It must be non-empty: a strict OpenAI-compatible gateway rejects an empty user
 * message with HTTP 400, and the marker derives to itself at the surface tail.
 */
export const MARKER_TEXT = '(session-rewind)';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A genuinely user-authored message: runtime context, instruction files and
 * projected notes are all `user/message` events with a different source kind.
 * @param {object} event
 * @returns {boolean}
 */
export function isHumanUserMessage(event) {
  return isRecord(event)
    && event.type === 'user/message'
    && isRecord(event.data)
    && isRecord(event.data.source)
    && event.data.source.kind === 'user';
}

/**
 * Join the text blocks of one message content array.
 * @param {unknown} content
 * @returns {string}
 */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== undefined && block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * Every user-authored message currently on the surface, newest first.
 * @param {readonly object[]} events
 * @param {readonly number[]} surface
 * @param {number} [limit]
 * @returns {Array<{ seq: number, time: number, preview: string, index: number }>}
 */
export function listCandidates(events, surface, limit = 100) {
  const onSurface = new Set(Array.isArray(surface) ? surface : []);
  const ordered = [];
  for (const event of events) {
    if (!isHumanUserMessage(event)) continue;
    if (typeof event.seq !== 'number' || !onSurface.has(event.seq)) continue;
    ordered.push(event);
  }
  const result = [];
  for (let index = ordered.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const event = ordered[index];
    result.push({
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      preview: textOf(event.data?.content),
      index: result.length + 1,
    });
  }
  return result;
}

/**
 * Plan one in-place rewind.
 *
 * `surfaceStart` is the target's own surface seq and `surfaceEnd` is the LAST
 * surface node — not the target — because the replace op shadows everything the
 * model still sees after the target as well.
 *
 * @param {readonly object[]} events
 * @param {readonly number[]} surface
 * @param {number} seq
 * @returns {{ targetSeq: number, surfaceStart: number, surfaceEnd: number, shadowedSeqs: number[] }}
 * @throws {Error & { code: string }}
 */
export function planInPlace(events, surface, seq) {
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  const nodes = Array.isArray(surface) ? surface : [];
  if (nodes.length === 0) throw fail('no-user-messages', 'this session has no rewritable message');
  const target = events.find((event) => event?.seq === seq);
  if (target === undefined) throw fail('not-a-user-message', 'that message is not in this session');
  if (!isHumanUserMessage(target)) {
    throw fail('not-a-user-message', 'only your own messages can be rewound to');
  }
  const targetIndex = nodes.indexOf(seq);
  if (targetIndex < 0) {
    throw fail('not-on-surface', 'that message is no longer part of the model context');
  }
  const shadowedSeqs = nodes.slice(targetIndex);
  return {
    targetSeq: seq,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  };
}

/**
 * The earliest surface cut this plugin has already executed, or null.
 *
 * The Chat view renders append-origin nodes only, so a declared rewind does not
 * remove the withdrawn rows by itself; the client hides every node at or after
 * this seq. Hiding is monotonic — an older cut always wins — so one number is
 * enough to describe any number of executed rewinds.
 *
 * @param {readonly object[]} events
 * @returns {number | null}
 */
export function hiddenFromSeq(events) {
  let earliest = null;
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== MARKER_SOURCE_KIND) continue;
    const start = event.surfaceOp;
    const startSeq = isRecord(start) && start.op === 'replace' ? start.startSeq : undefined;
    if (typeof startSeq !== 'number') continue;
    if (earliest === null || startSeq < earliest) earliest = startSeq;
  }
  return earliest;
}

/**
 * The Turn of the earliest executed cut, for views that can only address whole
 * Turns (the rendered Chat rows carry `data-chat-turn`, not a seq).
 * @param {readonly object[]} events
 * @returns {number | null}
 */
export function hiddenFromTurn(events) {
  const start = hiddenFromSeq(events);
  if (start === null) return null;
  let turn = null;
  let inside = null;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event.seq !== 'number' || event.seq > start) break;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) inside = event.data.turn;
    else if (event.type === 'turn/end' && Number.isInteger(event.data?.turn)) inside = null;
  }
  turn = inside;
  return Number.isInteger(turn) ? turn : null;
}

/**
 * Build the marker event payload. `id` is minted here because the Host's own
 * `createUserMessage` helper is not importable from a profile bundle.
 * @param {(id: string) => string} randomId
 * @returns {object}
 */
export function markerPayload(randomId) {
  return {
    role: 'user',
    id: randomId(`session-rewind-${Date.now()}`),
    content: [{ type: 'text', text: MARKER_TEXT }],
    source: { kind: MARKER_SOURCE_KIND },
  };
}
