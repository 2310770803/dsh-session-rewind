/**
 * Executing one in-place rewind against the live session.
 *
 * Order matters and is copied from the reference implementation's proven
 * sequence: a running Turn must be stopped first (the surface cannot be cut while
 * the model is streaming), pending *next-step* steering is dropped (it belongs to
 * the future being rolled back), the plan is re-derived after quiescence, and only
 * then is the single marker event appended.
 */

import { randomUUID } from 'node:crypto';

import { hiddenFromSeq, markerPayload, planInPlace, textOf, withdrawnTurns } from './surface.js';

/** Waiting budget for a cancelled Turn to reach quiescence. */
const IDLE_TIMEOUT_MS = 20_000;

const noop = () => {};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the live Agent that owns this session.
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {object | undefined}
 */
export function liveAgentOf(ctx, sessionId) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    if (agents === undefined || typeof agents.get !== 'function') return undefined;
    const agent = agents.get(sessionId);
    return isRecord(agent) ? agent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait for the Agent to be idle.
 * @param {object} agent
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForIdle(agent, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (agent?.status === 'idle') return true;
    if (Date.now() >= deadline) return false;
    try {
      if (typeof agent?.whenIdle === 'function') {
        const settled = await Promise.race([
          Promise.resolve(agent.whenIdle()).then(() => true, () => true),
          new Promise((resolve) => {
            setTimeout(() => resolve(false), Math.max(50, deadline - Date.now()));
          }),
        ]);
        if (settled === true && agent?.status === 'idle') return true;
        continue;
      }
    } catch {
      /* fall through to the poll below */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
}

/**
 * Drop the next-step (steering) inbox of one Agent, leaving queued next-turn
 * messages untouched — those are the user's to edit, not the rewind's to lose.
 * @param {object} agent
 */
function dropPendingSteering(agent) {
  try {
    const inbox = agent?.inbox;
    if (!isRecord(inbox) || !Array.isArray(inbox.nextStep) || inbox.nextStep.length === 0) return;
    for (const message of [...inbox.nextStep]) {
      try {
        inbox.remove?.(message);
      } catch {
        /* best-effort: a leftover steering message is dropped with the surface */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Plan a rewind against the live session without changing anything.
 * @param {object} session
 * @param {number} seq
 * @returns {{ targetSeq: number, surfaceStart: number, surfaceEnd: number, shadowedSeqs: number[], prompt: string, turn: number | null }}
 */
export function describeInPlace(session, seq) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const plan = planInPlace(events, surface, seq);
  const target = events.find((event) => event?.seq === seq);
  let turn = null;
  for (const event of events) {
    if (event?.seq > seq) break;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn;
  }
  return {
    ...plan,
    prompt: textOf(target?.data?.content),
    turn,
  };
}

/**
 * Execute one in-place rewind.
 *
 * @param {{
 *   ctx: object,
 *   sessionId: string,
 *   seq: number,
 *   restoreTurns: (fromTurn: number) => Promise<object | undefined>,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{
 *   markerSeq: number, targetSeq: number, prompt: string, turn: number | null,
 *   hiddenFromSeq: number | null, restore?: object,
 * }>}
 */
export async function executeInPlace({
  ctx,
  sessionId,
  seq,
  restoreTurns,
  readEvents,
  timeoutMs = IDLE_TIMEOUT_MS,
}) {
  const agent = liveAgentOf(ctx, sessionId);
  if (agent === undefined) {
    const error = new Error('this session is not live, so it cannot be rewound in place');
    error.status = 409;
    throw error;
  }
  const session = agent.session;
  if (!isRecord(session) || typeof session.append !== 'function') {
    const error = new Error('the session log is not writable in this DSH version');
    error.status = 503;
    throw error;
  }

  // A running Turn must stop before its surface can be cut.
  if (agent.status !== 'idle') {
    try {
      agent.cancel?.({ kind: 'user' }, { keepInbox: true });
    } catch {
      /* the cancel is advisory; quiescence is what matters */
    }
    const stopped = await waitForIdle(agent, timeoutMs);
    if (!stopped) {
      const error = new Error('the running Turn did not stop in time');
      error.status = 409;
      throw error;
    }
  }
  dropPendingSteering(agent);

  // Re-derive after quiescence: the surface may have moved while we waited.
  const plan = describeInPlace(session, seq);

  let event;
  try {
    event = session.append('user/message', markerPayload((seed) => `${seed}-${randomUUID()}`), {
      surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
      sourceEventSeqs: [...plan.shadowedSeqs],
    });
  } catch (error) {
    const wrapped = new Error(`the rewind marker was rejected: ${error instanceof Error ? error.message : String(error)}`);
    wrapped.status = 409;
    throw wrapped;
  }

  let restore;
  if (typeof restoreTurns === 'function' && Number.isInteger(plan.turn)) {
    try {
      restore = await restoreTurns(plan.turn);
    } catch (error) {
      // The conversation half already succeeded; the file half reports its own
      // failure instead of rolling the rewind back.
      restore = { failed: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  let hidden = null;
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    hidden = hiddenFromSeq(events);
  } catch {
    hidden = plan.surfaceStart;
  }

  let hiddenTurns = [];
  try {
    const after = typeof readEvents === 'function' ? await readEvents(sessionId) : [];
    hiddenTurns = [...withdrawnTurns(after)];
  } catch {
    /* the cut still applied; the client falls back to hiding from plan.turn */
  }

  return {
    markerSeq: typeof event?.seq === 'number' ? event.seq : -1,
    targetSeq: plan.targetSeq,
    prompt: plan.prompt,
    turn: plan.turn,
    hiddenFromSeq: hidden,
    hiddenTurns,
    ...(restore === undefined ? {} : { restore }),
  };
}

export const noopForTests = noop;
