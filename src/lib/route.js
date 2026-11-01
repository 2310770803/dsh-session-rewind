/**
 * The two plugin-owned Host HTTP routes behind the browser's rewind control.
 *
 * They are same-origin, loopback-only control routes: the plan route reports
 * what a rewind would do, the restore route performs the file half of it. The
 * conversation half is a Client-side `sessions.fork`, so no Host route mutates
 * the conversation at all.
 *
 * Both handlers answer with a status and a short body on every failure path and
 * never throw, so a missing or renamed Host service can only cost the rewind
 * control, never the application.
 *
 * The request fence mirrors DSH Web's own `/api` Host/Origin trust check: the
 * request must come from a loopback (or trusted) authority, must not be a
 * cross-site fetch, and its Origin must match the Host header.
 */

export const PLAN_PATH = '/api/session-rewind.plan';
export const RESTORE_PATH = '/api/session-rewind.restore';
export const CANDIDATES_PATH = '/api/session-rewind.candidates';
export const INPLACE_PATH = '/api/session-rewind.inplace';
export const CUTS_PATH = '/api/session-rewind.cuts';
export const DIAGNOSE_PATH = '/api/session-rewind.diagnose';
export const TAIL_PATH = '/api/session-rewind.tail';
export const SURFACE_PATH = '/api/session-rewind.surface';
export const SELFCHECK_PATH = '/api/session-rewind.selfcheck';

/** A rewind request is a session id plus a Turn number or a seq. */
export const MAX_REQUEST_BYTES = 16 * 1024;

export class RequestBoundaryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestBoundaryError';
    this.status = status;
  }
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string') return false;
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return entryUrl.port === '' || entryUrl.port === hostUrl.port
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/**
 * Mirror DSH Web's own `/api` Host/Origin trust fence for a plugin route.
 * @param {import('node:http').IncomingMessage} request
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
export function isTrustedRequest(request, trustedHosts) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestBoundaryError(413, 'request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') throw new RequestBoundaryError(400, 'request body must be valid JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBoundaryError(400, 'request body must be valid JSON');
  }
}

function writeText(response, status, text) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function hostsOf(resolve) {
  try {
    const hosts = resolve();
    return Array.isArray(hosts) ? hosts.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

function fail(response, error, onError) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  if (!(error instanceof RequestBoundaryError)) {
    try {
      onError(error);
    } catch {
      /* logging must not mask the response */
    }
  }
  const text = status === 500 ? 'the rewind request failed' : messageOf(error);
  try {
    writeText(response, status, text);
  } catch {
    /* the response may already be gone */
  }
}

/**
 * Shape one archived file for the browser.
 * @param {object} file
 * @returns {{ path: string, displayPath: string, action: 'restore' | 'delete' | 'skip', size: number, reason?: string }}
 */
function planFile(file) {
  const action = file.existed !== true
    ? 'delete'
    : typeof file.blob === 'string'
      ? 'restore'
      : 'skip';
  return {
    path: file.path,
    displayPath: file.displayPath,
    action,
    size: Number.isFinite(file.size) ? file.size : 0,
    ...(typeof file.reason === 'string' ? { reason: file.reason } : {}),
  };
}

/**
 * Read the `{ sessionId, turn?, seq? }` request target.
 * @param {unknown} value
 * @returns {{ sessionId: string, turn: number | undefined, seq: number | undefined }}
 */
function targetOf(value) {
  if (!isRecord(value)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
  const turn = Number.isInteger(value.turn) ? value.turn : undefined;
  const seq = Number.isInteger(value.seq) ? value.seq : undefined;
  if (turn === undefined && seq === undefined) {
    throw new RequestBoundaryError(400, 'turn or seq is required');
  }
  return { sessionId, turn, seq };
}

/**
 * Build the surface route.
 *
 * `planInPlace` refuses a rewind when the target Seq is not a node of the live
 * Session's surface, so when a click is refused the only useful question is what
 * that surface actually contains. This exposes it read-only.
 *
 * @param {{
 *   surfaceOf: (sessionId: string) => { nodes?: readonly unknown[]; replaceGeneration?: number; contentGeneration?: number } | null,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSurfaceHandler({ surfaceOf, trustedHosts = () => [], onError = () => {} }) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const value = await readJsonBody(request);
      if (!isRecord(value)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      const live = surfaceOf(sessionId);
      if (live === null) throw new RequestBoundaryError(409, 'this session is not open right now');
      const nodes = Array.isArray(live.nodes) ? live.nodes.map((node) => (typeof node === 'number' ? node : null)) : [];
      const tail = Number.isInteger(value.tail) && value.tail > 0 && value.tail <= 200 ? value.tail : 20;
      writeJson(response, 200, {
        ok: true,
        count: nodes.length,
        replaceGeneration: live.replaceGeneration ?? null,
        contentGeneration: live.contentGeneration ?? null,
        head: nodes.slice(0, 10),
        tail: nodes.slice(-tail),
      });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the event-tail route.
 *
 * Returns the last N events of a Session in reading order with just enough shape
 * to reason about a rewind: seq, type, source kind and a short text sample. It is
 * the only way to see whether a marker actually landed, because the on-disk log is
 * compressed and may lag behind the live surface.
 *
 * @param {{
 *   events: (sessionId: string) => Promise<readonly unknown[]>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createTailHandler({ events, trustedHosts = () => [], onError = () => {} }) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const value = await readJsonBody(request);
      if (!isRecord(value)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      const limit = Number.isInteger(value.limit) && value.limit > 0 && value.limit <= 300 ? value.limit : 40;
      const all = await events(sessionId);
      const slice = all.slice(-limit);
      writeJson(response, 200, {
        ok: true,
        total: all.length,
        events: slice.map((event) => summarizeEvent(event)),
      });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Reduce one Session event to the fields worth inspecting.
 *
 * @param {unknown} event
 * @returns {{ seq: number | null, type: string, sourceKind: string | null, role: string | null, text: string | null }}
 */
function summarizeEvent(event) {
  const record = isRecord(event) ? event : {};
  const data = isRecord(record.data) ? record.data : {};
  const source = isRecord(data.source) ? data.source : {};
  const content = Array.isArray(data.content) ? data.content : [];
  const first = content.find((part) => isRecord(part) && part.type === 'text');
  const text = isRecord(first) && typeof first.text === 'string' ? first.text.slice(0, 60) : null;
  return {
    seq: Number.isInteger(record.seq) ? record.seq : null,
    type: typeof record.type === 'string' ? record.type : '(none)',
    sourceKind: typeof source.kind === 'string' ? source.kind : null,
    role: typeof data.role === 'string' ? data.role : null,
    text,
  };
}

/**
 * Build the browser-diagnostics route.
 *
 * The Web half cannot be inspected from the Host, so the page reports what it
 * actually sees (how many chat rows exist, which attributes they carry, and any
 * error the per-message bridge hit). It keeps the last few reports per Session in
 * memory — never on disk — and they contain no message text.
 *
 * @param {{
 *   remember: (sessionId: string, report: unknown) => void,
 *   recall: (sessionId: string) => readonly unknown[],
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDiagnoseHandler({ remember, recall, trustedHosts = () => [], onError = () => {} }) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      if (body.read === true) {
        writeJson(response, 200, { ok: true, reports: recall(sessionId) });
        return;
      }
      remember(sessionId, body.report);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the in-place rewind route.
 *
 * `dryRun` returns the plan (what would be cut, and the prompt that would come
 * back) without touching the log, which is what lets the browser preview the
 * action and what makes the whole path testable against a live session.
 *
 * @param {{
 *   describe: (sessionId: string, seq: number) => object,
 *   execute: (sessionId: string, seq: number, restoreFiles: boolean) => Promise<object>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createInplaceHandler({
  describe,
  execute,
  trustedHosts = () => [],
  onError = () => {},
}) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      if (!Number.isInteger(body.seq) || body.seq < 0) {
        throw new RequestBoundaryError(400, 'seq must be a non-negative integer');
      }
      if (body.dryRun === true) {
        const plan = await describe(sessionId, body.seq);
        writeJson(response, 200, { ok: true, dryRun: true, plan });
        return;
      }
      const result = await execute(sessionId, body.seq, body.restoreFiles !== false);
      writeJson(response, 200, { ok: true, ...result });
    } catch (error) {
      if (typeof error?.code === 'string' && error?.status === undefined) {
        try {
          // A planning refusal is the caller's problem, not a server fault.
          writeJson(response, 409, { ok: false, code: error.code, message: messageOf(error) });
          return;
        } catch {
          /* fall through to the generic failure path */
        }
      }
      fail(response, error, onError);
    }
  };
}

/**
 * Build the cuts route: the earliest surface cut already executed in a Session,
 * which the Chat view uses to hide the withdrawn rows.
 *
 * @param {{
 *   cutsOf: (sessionId: string) => Promise<number | null>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createCutsHandler({ cutsOf, trustedHosts = () => [], onError = () => {} }) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const value = await readJsonBody(request);
      if (!isRecord(value)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      const cuts = await cutsOf(sessionId);
      writeJson(response, 200, {
        ok: true,
        ...(isRecord(cuts) ? cuts : { hiddenFromSeq: null, hiddenFromTurn: null }),
      });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the candidate route: every finished Turn this Session can be rewound to,
 * newest first, each with the prompt it was sent with and what the file archive
 * holds for it.
 *
 * The chat header offers this list so a rewind does not require scrolling back to
 * the Turn itself.
 *
 * @param {{
 *   listTurns: (sessionId: string, limit: number) => Promise<readonly object[]>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createCandidatesHandler({
  listTurns,
  trustedHosts = () => [],
  onError = () => {},
}) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }
      const value = await readJsonBody(request);
      if (!isRecord(value)) throw new RequestBoundaryError(400, 'request body must be a JSON object');
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
      if (sessionId === '') throw new RequestBoundaryError(400, 'sessionId is required');
      const limit = Number.isInteger(value.limit) && value.limit > 0 && value.limit <= 200 ? value.limit : 50;
      const turns = await listTurns(sessionId, limit);
      writeJson(response, 200, { ok: true, turns });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the read-only self-check route: what this plugin is actually wired to in
 * the running Host. It performs no mutation and exposes no session content, so it
 * is safe to leave behind as a support diagnostic.
 *
 * @param {{
 *   describe: () => Promise<object>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSelfcheckHandler({ describe, trustedHosts = () => [], onError = () => {} }) {
  return async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      writeJson(response, 200, { ok: true, ...(await describe()) });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the plan route: "what would rewinding to this Turn do?".
 *
 * @param {{
 *   archive: { get: (sessionId: string, turn: number) => Promise<object | null> },
 *   describeTurn: (sessionId: string, options: { turn?: number, seq?: number }) => Promise<{ turn: number, endSeq: number | null } | null>,
 *   userPromptOf: (sessionId: string, turn: number) => Promise<string | null>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createPlanHandler({
  archive,
  describeTurn,
  userPromptOf,
  trustedHosts = () => [],
  onError = () => {},
}) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }

      const target = targetOf(await readJsonBody(request));
      const described = await describeTurn(target.sessionId, { turn: target.turn, seq: target.seq });
      if (described === null) {
        throw new RequestBoundaryError(409, 'that Turn is not part of this session');
      }

      const entry = await archive.get(target.sessionId, described.turn);
      const files = Array.isArray(entry?.files) ? entry.files.map(planFile) : [];

      let prompt = null;
      try {
        prompt = await userPromptOf(target.sessionId, described.turn);
      } catch (error) {
        onError(error);
      }

      writeJson(response, 200, {
        ok: true,
        turn: described.turn,
        seq: described.endSeq,
        prompt: typeof prompt === 'string' && prompt !== '' ? prompt : null,
        files,
      });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}

/**
 * Build the restore route: put the selected files back to their pre-Turn state.
 *
 * The browser may only select paths that the archive already recorded for this
 * Session and Turn; the request never names a path the Host resolves on its own.
 *
 * @param {{
 *   archive: {
 *     get: (sessionId: string, turn: number) => Promise<object | null>,
 *     markRestored: (sessionId: string, turn: number) => Promise<void>,
 *   },
 *   describeTurn: (sessionId: string, options: { turn?: number, seq?: number }) => Promise<{ turn: number, endSeq: number | null } | null>,
 *   restoreFile: (file: object, context: { workspaceRoot?: string, sessionId: string }) => Promise<{ path: string, status: string, message?: string }>,
 *   trustedHosts?: () => readonly string[],
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRestoreHandler({
  archive,
  describeTurn,
  restoreFile,
  trustedHosts = () => [],
  onError = () => {},
}) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        writeText(response, 405, 'method not allowed');
        return;
      }
      if (!isTrustedRequest(request, hostsOf(trustedHosts))) {
        writeText(response, 403, 'forbidden');
        return;
      }
      const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeText(response, 415, 'content type must be application/json');
        return;
      }

      const body = await readJsonBody(request);
      const target = targetOf(body);
      const described = await describeTurn(target.sessionId, { turn: target.turn, seq: target.seq });
      if (described === null) {
        throw new RequestBoundaryError(409, 'that Turn is not part of this session');
      }

      const entry = await archive.get(target.sessionId, described.turn);
      if (entry === null) {
        writeJson(response, 200, { ok: true, turn: described.turn, results: [] });
        return;
      }

      const requested = isRecord(body) && Array.isArray(body.paths)
        ? new Set(body.paths.filter((path) => typeof path === 'string'))
        : null;
      const selected = Array.isArray(entry.files)
        ? entry.files.filter((file) => requested === null || requested.has(file.path))
        : [];
      const context = {
        workspaceRoot: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
        sessionId: target.sessionId,
      };

      const results = [];
      for (const file of selected) {
        if (file.existed === true && typeof file.blob !== 'string') {
          results.push({
            path: file.displayPath,
            status: 'skipped',
            message: 'the pre-Turn content of this file was not recorded',
          });
          continue;
        }
        try {
          results.push(await restoreFile(file, context));
        } catch (error) {
          results.push({ path: file.displayPath, status: 'failed', message: messageOf(error) });
        }
      }

      const changed = results.some((result) => result.status === 'restored' || result.status === 'deleted');
      if (changed) {
        try {
          await archive.markRestored(target.sessionId, described.turn);
        } catch (error) {
          onError(error);
        }
      }

      writeJson(response, 200, { ok: true, turn: described.turn, results });
    } catch (error) {
      fail(response, error, onError);
    }
  };
}
