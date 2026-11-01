/**
 * Native DSH Host half: the file half of "rewind a finished Turn".
 *
 * What it does
 *  - watches every filesystem mutation that happens inside a Turn and stores
 *    the pre-mutation bytes of the target (the same `fs/write-intent` /
 *    `fs/edit-intent` waterfall `workspace-changes` uses, with the tool
 *    execution mapped back to its Session through `tools/pre-execute`);
 *  - serves two same-origin routes: one reports what rewinding to a Turn would
 *    restore, one performs the restore.
 *
 * The conversation half is deliberately not here: the browser half forks the
 * Session through the Client `sessions` service, because the session log is
 * append-only and forking is the only supported way to branch it.
 *
 * Defensive by construction, following the same shape as `dsh-session-copy`:
 *  - no required `inject` entries, so a renamed Host service can never stop the
 *    plugin from activating;
 *  - `fs` and `webServer` are awaited through `ctx.inject`, and `sessionQuery`
 *    is resolved lazily per request;
 *  - every step is wrapped, so a throw here is logged and swallowed instead of
 *    reaching the loader's activation audit.
 */

import { archiveDirectory, createArchive } from './lib/archive.js';
import { restoreFile as restoreOne } from './lib/restore.js';
import {
  CANDIDATES_PATH,
  CUTS_PATH,
  DIAGNOSE_PATH,
  INPLACE_PATH,
  PLAN_PATH,
  RESTORE_PATH,
  SELFCHECK_PATH,
  createCandidatesHandler,
  createCutsHandler,
  createDiagnoseHandler,
  createInplaceHandler,
  createPlanHandler,
  createRestoreHandler,
  createSelfcheckHandler,
} from './lib/route.js';
import { describeInPlace, executeInPlace, liveAgentOf } from './lib/inplace.js';
import { hiddenFromSeq, hiddenFromTurn } from './lib/surface.js';

export const name = 'session-rewind';

/** Nothing is required at activation time; every service is resolved lazily. */
export const inject = [];

/** Cap on the prompt handed back to the composer. */
const MAX_PROMPT_CHARACTERS = 20_000;

function report(ctx, level, error) {
  try {
    const logger = ctx?.logger;
    const write = logger?.[level];
    if (typeof write === 'function') {
      write.call(logger, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'warn']('[dsh-session-rewind]', error);
  } catch {
    /* diagnostics must never escalate */
  }
}

function serviceOf(scope, ctx, serviceName) {
  try {
    const fromScope = scope?.get?.(serviceName);
    if (fromScope !== undefined && fromScope !== null) return fromScope;
  } catch {
    /* fall through to the root context */
  }
  try {
    const fromRoot = ctx?.get?.(serviceName);
    if (fromRoot !== undefined && fromRoot !== null) return fromRoot;
  } catch {
    /* treat as unavailable */
  }
  return undefined;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Join the text blocks of one message content array. */
function textOfContent(content) {
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
 * Read the complete committed event log of one Session.
 *
 * `sessionQuery.readSession` replays and validates the durable log, which is
 * what a rewind must reason about. A live Session object is the fallback for
 * releases where the query service is unavailable.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<readonly object[]>}
 */
async function readEvents(ctx, sessionId) {
  const query = serviceOf(undefined, ctx, 'sessionQuery');
  if (query !== undefined && typeof query.readSession === 'function') {
    const snapshot = await query.readSession(sessionId);
    if (Array.isArray(snapshot?.events)) return snapshot.events;
  }
  const sessions = serviceOf(undefined, ctx, 'sessions');
  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
  if (Array.isArray(live?.events)) return live.events;
  if (typeof live?.snapshotEvents === 'function') {
    const events = live.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  const error = new Error('the session log is unavailable in this DSH version');
  error.status = 503;
  throw error;
}

/**
 * Locate one Turn in a log and its fork boundary.
 *
 * @param {readonly object[]} events
 * @param {{ turn?: number, seq?: number }} options
 * @returns {{ turn: number, endSeq: number | null } | null}
 */
export function locateTurn(events, options) {
  const starts = [];
  const ends = new Map();
  for (const event of events) {
    if (!isRecord(event)) continue;
    const turn = event.data?.turn;
    if (!Number.isInteger(turn)) continue;
    const seq = typeof event.seq === 'number' ? event.seq : -1;
    if (event.type === 'turn/start') starts.push({ turn, seq });
    else if (event.type === 'turn/end') ends.set(turn, typeof event.seq === 'number' ? event.seq : null);
  }

  let turn = Number.isInteger(options.turn) ? options.turn : undefined;
  if (turn === undefined && Number.isInteger(options.seq)) {
    let best;
    for (const start of starts) {
      if (start.seq > options.seq) continue;
      if (best === undefined || start.seq > best.seq) best = start;
    }
    turn = best?.turn;
  }
  if (turn === undefined) return null;
  // A requested Turn number is only honoured when the log actually opened it;
  // otherwise the caller would be handing `sessions.fork` a boundary of its own
  // invention.
  if (!starts.some((start) => start.turn === turn)) return null;
  return { turn, endSeq: ends.get(turn) ?? null };
}

/**
 * The prompt the user sent for one Turn, when the Turn has one.
 *
 * Only genuinely user-authored messages count: runtime context, instruction
 * files, projected notes and steering notices are all `user/message` events
 * with a different `source.kind`, and none of them belong in a composer.
 *
 * @param {readonly object[]} events
 * @param {number} turn
 * @returns {string | null}
 */
export function userPromptOf(events, turn) {
  let inside = false;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === 'turn/start' && event.data?.turn === turn) {
      inside = true;
      continue;
    }
    if (event.type === 'turn/end' && event.data?.turn === turn) break;
    if (!inside || event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (isRecord(source) && source.kind !== 'user') continue;
    const text = textOfContent(event.data?.content);
    if (text !== '') return text.slice(0, MAX_PROMPT_CHARACTERS);
  }
  return null;
}

/**
 * The Turn still open in a live Session, or undefined when the last committed
 * event closed one.
 *
 * The `session/event` feed owns this in steady state, but a plugin can also be
 * activated while a Turn is already running (install, reload, profile restart
 * mid-Turn), and then no `turn/start` is ever delivered for that Turn. Reading
 * the tail of the live log recovers it without guessing.
 *
 * @param {object} session
 * @returns {number | undefined}
 */
function openTurnOf(session) {
  let events;
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents();
      if (Array.isArray(snapshot)) events = snapshot;
    }
  } catch {
    /* fall through to the plain accessor */
  }
  if (events === undefined) {
    try {
      const raw = session?.events;
      if (Array.isArray(raw)) events = raw;
    } catch {
      /* an unreadable log only costs the capture */
    }
  }
  if (events === undefined) return undefined;

  // Only the tail can hold the open Turn; a long Session must not be walked in
  // full on every miss.
  const floor = Math.max(0, events.length - 5000);
  for (let index = events.length - 1; index >= floor; index -= 1) {
    const event = events[index];
    if (!isRecord(event)) continue;
    if (event.type === 'turn/end') return undefined;
    if (event.type === 'turn/start') {
      const turn = event.data?.turn;
      return Number.isInteger(turn) ? turn : undefined;
    }
  }
  return undefined;
}

/**
 * @param {object} ctx DSH Cordis context.
 */
export function apply(ctx) {
  /** @type {ReturnType<typeof createArchive> | undefined} */
  let archive;
  try {
    archive = createArchive({
      directory: archiveDirectory(),
      warn: (error) => report(ctx, 'warn', error),
    });
    ctx.effect(() => () => {
      try {
        const closing = archive?.close();
        if (closing !== undefined) closing.catch(() => {});
      } catch {
        /* teardown must never throw */
      }
    }, 'session-rewind: archive');
  } catch (error) {
    report(ctx, 'error', error);
    return;
  }

  /** Session id → the Turn currently open for that Session. */
  const openTurns = new Map();
  /** Tool execution → the Session that issued it (a WeakMap, so it never leaks). */
  const actors = new WeakMap();

  try {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return;
        if (event?.type === 'turn/start') {
          const turn = event.data?.turn;
          if (Number.isInteger(turn)) openTurns.set(sessionId, turn);
          return;
        }
        if (event?.type === 'turn/end') openTurns.delete(sessionId);
      } catch {
        /* an event we cannot read must not break the Turn */
      }
    });

    ctx.on('session/disposed', (session) => {
      try {
        const sessionId = session?.id;
        if (typeof sessionId === 'string') openTurns.delete(sessionId);
      } catch {
        /* nothing to clean */
      }
    });

    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const session = exec?.agent?.session;
        const sessionId = session?.id;
        if (typeof sessionId === 'string' && sessionId !== '') {
          const cwd = session?.header?.cwd;
          actors.set(exec, {
            sessionId,
            session,
            cwd: typeof cwd === 'string' ? cwd : undefined,
          });
        }
      } catch {
        /* mapping is best-effort */
      }
      return next();
    });
  } catch (error) {
    report(ctx, 'warn', error);
  }

  // Capture pre-images while `fs` is available. The listener runs before the
  // mutation is applied, so reading the target now yields the pre-Turn bytes.
  try {
    ctx.inject(['fs'], (scope) => {
      const capture = async (target, actor) => {
        const owner = isRecord(actor) || typeof actor === 'function' ? actors.get(actor) : undefined;
        if (owner === undefined) return;
        let turn = openTurns.get(owner.sessionId);
        if (!Number.isInteger(turn)) {
          // Recovery path for a plugin mounted mid-Turn: derive it once from the
          // live log, then cache it until the next `turn/start`/`turn/end`.
          turn = openTurnOf(owner.session);
          if (!Number.isInteger(turn)) return;
          openTurns.set(owner.sessionId, turn);
        }
        let absolute;
        try {
          absolute = scope.fs.processPath(target);
        } catch {
          return;
        }
        if (typeof absolute !== 'string' || absolute === '') return;
        await archive?.record({
          sessionId: owner.sessionId,
          turn,
          cwd: owner.cwd,
          absolute,
          displayPath: typeof target?.displayPath === 'string' && target.displayPath !== ''
            ? target.displayPath
            : absolute,
        });
      };

      const listen = (eventName) => {
        scope.on(eventName, async (target, actor, next) => {
          const intent = await next();
          try {
            await capture(target, actor);
          } catch (error) {
            report(ctx, 'warn', error);
          }
          return intent;
        }, { prepend: true });
      };

      try {
        listen('fs/write-intent');
        listen('fs/edit-intent');
      } catch (error) {
        report(ctx, 'warn', error);
      }
    });
  } catch (error) {
    report(ctx, 'warn', error);
  }

  try {
    ctx.inject(['webServer'], (scope) => {
      const describeTurn = async (sessionId, options) => {
        const events = await readEvents(ctx, sessionId);
        return locateTurn(events, options);
      };

      const userPrompt = async (sessionId, turn) => {
        const events = await readEvents(ctx, sessionId);
        return userPromptOf(events, turn);
      };

      /**
       * The user-authored message that opened one Turn, if the Turn has one.
       * This is the in-place rewind target: the marker replaces it and every
       * surface node after it.
       */
      const userMessageOf = (events, turn) => {
        let inside = false;
        for (const event of events) {
          if (!isRecord(event)) continue;
          if (event.type === 'turn/start' && event.data?.turn === turn) {
            inside = true;
            continue;
          }
          if (event.type === 'turn/end' && event.data?.turn === turn) return null;
          if (!inside || event.type !== 'user/message') continue;
          if (event.data?.source?.kind !== 'user') continue;
          if (typeof event.seq !== 'number') continue;
          return event;
        }
        return null;
      };

      const liveSession = (sessionId) => {
        const agent = liveAgentOf(ctx, sessionId);
        const session = agent?.session;
        if (session === undefined || session === null) {
          const error = new Error('this session is not live, so it cannot be rewound in place');
          error.status = 409;
          throw error;
        }
        return session;
      };

      /** Restore every archived Turn at or after `fromTurn` (newest first). */
      const restoreTurns = async (sessionId, fromTurn) => {
        const fsService = serviceOf(scope, ctx, 'fs');
        if (fsService === undefined) return undefined;
        const syncObservation = async (absolute, observation) => {
          try {
            const target = await fsService.resolve(absolute);
            const emit = typeof scope.emit === 'function' ? scope.emit.bind(scope) : undefined;
            if (emit !== undefined) emit('fs/observed', target, observation, undefined);
          } catch {
            /* best-effort */
          }
        };
        const summary = { restored: 0, deleted: 0, failed: 0, skipped: 0, turns: [] };
        let turn = Number.isInteger(fromTurn) ? fromTurn : undefined;
        if (turn === undefined) return summary;
        // The archive is keyed by turn; scan forward until a turn has no record.
        for (let current = turn; current < turn + 400; current += 1) {
          let entry = null;
          try {
            entry = await archive.get(sessionId, current);
          } catch {
            entry = null;
          }
          if (entry === null) continue;
          const context = {
            workspaceRoot: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
            sessionId,
          };
          for (const file of Array.isArray(entry.files) ? entry.files : []) {
            if (file.existed === true && typeof file.blob !== 'string') {
              summary.skipped += 1;
              continue;
            }
            try {
              const outcome = await restoreOne({ fsService, archive, file, ...context, syncObservation });
              if (outcome.status === 'restored') summary.restored += 1;
              else if (outcome.status === 'deleted') summary.deleted += 1;
              else if (outcome.status === 'skipped') summary.skipped += 1;
              else summary.failed += 1;
            } catch {
              summary.failed += 1;
            }
          }
          summary.turns.push(current);
        }
        return summary;
      };

      const describeInPlaceFor = (sessionId, seq) => describeInPlace(liveSession(sessionId), seq);

      const executeInPlaceFor = (sessionId, seq, restoreFiles) => executeInPlace({
        ctx,
        sessionId,
        seq,
        restoreTurns: restoreFiles === true
          ? async (fromTurn) => restoreTurns(sessionId, fromTurn)
          : undefined,
      });

      const cutsOf = async (sessionId) => {
        // Read the durable log: the client needs the cut after a page reload too.
        const events = await readEvents(ctx, sessionId);
        return { hiddenFromSeq: hiddenFromSeq(events), hiddenFromTurn: hiddenFromTurn(events) };
      };

      /**
       * Every finished Turn of one Session, newest first, as a rewind target.
       * A candidate needs a committed `turn/end` seq because that is the boundary
       * `sessions.fork` accepts.
       */
      const listTurns = async (sessionId, limit) => {
        const events = await readEvents(ctx, sessionId);
        const ends = [];
        for (const event of events) {
          if (!isRecord(event)) continue;
          if (event.type !== 'turn/end') continue;
          const turn = event.data?.turn;
          if (!Number.isInteger(turn)) continue;
          ends.push({ turn, seq: typeof event.seq === 'number' ? event.seq : null });
        }
        const candidates = [];
        for (const end of ends.reverse()) {
          if (candidates.length >= limit) break;
          let entry = null;
          try {
            entry = await archive.get(sessionId, end.turn);
          } catch {
            /* the archive is optional here */
          }
          const files = Array.isArray(entry?.files) ? entry.files : [];
          const userMessage = userMessageOf(events, end.turn);
          candidates.push({
            turn: end.turn,
            seq: end.seq,
            userSeq: userMessage === null ? null : userMessage.seq,
            prompt: userPromptOf(events, end.turn),
            files: {
              count: files.length,
              restorable: files.filter((file) => file.existed !== true || typeof file.blob === 'string').length,
            },
          });
        }
        return candidates;
      };

      const trustedHosts = () => {
        const runtime = serviceOf(scope, ctx, 'webRuntime');
        const hosts = runtime?.trustedHosts;
        return Array.isArray(hosts) ? hosts : [];
      };

      const onError = (error) => report(ctx, 'warn', error);

      const planHandler = createPlanHandler({
        archive,
        describeTurn,
        userPromptOf: userPrompt,
        trustedHosts,
        onError,
      });

      const restoreHandler = createRestoreHandler({
        archive,
        describeTurn,
        restoreFile: async (file, context) => {
          const fsService = serviceOf(scope, ctx, 'fs');
          if (fsService === undefined) {
            const error = new Error('the fs service is unavailable in this DSH version');
            error.status = 503;
            throw error;
          }
          // A raw-Node restore is invisible to the fs observation policy; publish
          // the true state so the Session's next write of the same path is not
          // judged against the stale pre-restore observation.
          const syncObservation = async (absolute, observation) => {
            try {
              const target = await fsService.resolve(absolute);
              const emit = typeof scope.emit === 'function' ? scope.emit.bind(scope) : undefined;
              if (emit === undefined) return;
              emit('fs/observed', target, observation, undefined);
            } catch {
              /* best-effort */
            }
          };
          return restoreOne({ fsService, archive, file, ...context, syncObservation });
        },
        trustedHosts,
        onError,
      });

      const statusHandler = createSelfcheckHandler({
        describe: async () => {
          let clientPath = null;
          try {
            const clientModules = serviceOf(scope, ctx, 'clientModules');
            const path = typeof clientModules?.clientPath === 'function'
              ? clientModules.clientPath('dsh-session-rewind')
              : undefined;
            if (typeof path === 'string' && path !== '') clientPath = path;
          } catch {
            /* the client table is optional */
          }
          let archiveStats = { turns: 0, files: 0 };
          try {
            archiveStats = await archive.stats();
          } catch {
            /* totals are diagnostics only */
          }
          return {
            plugin: 'dsh-session-rewind',
            archive: { directory: archive.directory, ...archiveStats },
            client: { discovered: clientPath !== null, path: clientPath },
            routes: [SELFCHECK_PATH, DIAGNOSE_PATH, CANDIDATES_PATH, INPLACE_PATH, CUTS_PATH, PLAN_PATH, RESTORE_PATH],
          };
        },
        trustedHosts,
        onError,
      });

      const candidatesHandler = createCandidatesHandler({
        listTurns,
        trustedHosts,
        onError,
      });

      const inplaceHandler = createInplaceHandler({
        describe: describeInPlaceFor,
        execute: executeInPlaceFor,
        trustedHosts,
        onError,
      });

      /** Last few browser reports per Session, in memory only. */
      const diagnostics = new Map();
      const diagnoseHandler = createDiagnoseHandler({
        remember: (sessionId, report) => {
          const list = diagnostics.get(sessionId) ?? [];
          list.push({ at: Date.now(), report });
          while (list.length > 5) list.shift();
          diagnostics.set(sessionId, list);
        },
        recall: (sessionId) => diagnostics.get(sessionId) ?? [],
        trustedHosts,
        onError,
      });

      const cutsHandler = createCutsHandler({
        cutsOf,
        trustedHosts,
        onError,
      });

      try {
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: DIAGNOSE_PATH, handler: diagnoseHandler }),
          'session-rewind: diagnose route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: SELFCHECK_PATH, handler: statusHandler }),
          'session-rewind: selfcheck route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: CANDIDATES_PATH, handler: candidatesHandler }),
          'session-rewind: candidates route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: INPLACE_PATH, handler: inplaceHandler }),
          'session-rewind: in-place route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: CUTS_PATH, handler: cutsHandler }),
          'session-rewind: cuts route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: PLAN_PATH, handler: planHandler }),
          'session-rewind: plan route',
        );
        scope.effect(
          () => scope.webServer.register({ kind: 'exact', path: RESTORE_PATH, handler: restoreHandler }),
          'session-rewind: restore route',
        );
      } catch (error) {
        report(ctx, 'error', error);
      }
    });
  } catch (error) {
    report(ctx, 'error', error);
  }
}
