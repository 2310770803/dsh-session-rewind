/**
 * Route-level test: the two Host routes through their real fences and shape,
 * with a real archive and a stubbed Turn lookup.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createArchive } from '../src/lib/archive.js';
import {
  CANDIDATES_PATH,
  PLAN_PATH,
  RESTORE_PATH,
  createCandidatesHandler,
  createCutsHandler,
  createInplaceHandler,
  createPlanHandler,
  createRestoreHandler,
} from '../src/lib/route.js';

const root = await mkdtemp(join(tmpdir(), 'rewind-route-'));
const archive = createArchive({ directory: join(root, 'archive') });
const file = join(root, 'src', 'main.ts');
const { mkdir } = await import('node:fs/promises');
await mkdir(join(root, 'src'), { recursive: true });
await writeFile(file, 'const a = 1;\n', 'utf8');

const sessionId = 'session-route-1';
await archive.record({ sessionId, turn: 2, absolute: file, displayPath: 'src/main.ts' });

const describeTurn = async (id, options) => {
  if (id !== sessionId) return null;
  const turn = Number.isInteger(options.turn) ? options.turn : 2;
  if (turn !== 2) return null;
  return { turn, endSeq: 41 };
};

const restored = [];
const planHandler = createPlanHandler({
  archive,
  describeTurn,
  userPromptOf: async () => 'make it dark',
  trustedHosts: () => [],
});
const restoreHandler = createRestoreHandler({
  archive,
  describeTurn,
  restoreFile: async (entry) => {
    restored.push(entry.path);
    return { path: entry.displayPath, status: 'restored' };
  },
  trustedHosts: () => [],
});

const HOST = '127.0.0.1:64031';

function request(body, options = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    method: options.method ?? 'POST',
    headers: {
      host: options.host ?? HOST,
      origin: options.origin ?? (options.host === undefined ? `http://${HOST}` : options.origin),
      'content-type': options.contentType ?? 'application/json',
      ...(options.headers ?? {}),
    },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8');
    },
  };
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

// --- plan ----------------------------------------------------------------
let res = response();
await planHandler(request({ sessionId, turn: 2 }), res);
assert.equal(res.status, 200);
const plan = JSON.parse(res.body);
assert.deepEqual(plan, {
  ok: true,
  turn: 2,
  seq: 41,
  prompt: 'make it dark',
  files: [{ path: file, displayPath: 'src/main.ts', action: 'restore', size: 13 }],
});
assert.equal(res.headers['Cache-Control'], 'no-store');
assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');

// seq-only targeting works too
res = response();
await planHandler(request({ sessionId, seq: 40 }), res);
assert.equal(res.status, 200);

// --- plan gates ----------------------------------------------------------
res = response();
await planHandler(request({ sessionId, turn: 2 }, { method: 'GET' }), res);
assert.equal(res.status, 405);

res = response();
await planHandler(request({ sessionId, turn: 2 }, { host: 'example.com', origin: 'http://example.com' }), res);
assert.equal(res.status, 403);

res = response();
await planHandler(request({ sessionId, turn: 2 }, { headers: { 'sec-fetch-site': 'cross-site' } }), res);
assert.equal(res.status, 403);

res = response();
await planHandler(request({ sessionId, turn: 2 }, { origin: 'http://evil.example' }), res);
assert.equal(res.status, 403);

res = response();
await planHandler(request({ sessionId, turn: 2 }, { contentType: 'text/plain' }), res);
assert.equal(res.status, 415);

res = response();
await planHandler(request({ sessionId: '' }), res);
assert.equal(res.status, 400);

res = response();
await planHandler(request({ sessionId }), res);
assert.equal(res.status, 400);

res = response();
await planHandler(request({ sessionId: 'other', turn: 2 }), res);
assert.equal(res.status, 409);

// --- candidates ----------------------------------------------------------
const listTurns = async (id, limit) => {
  if (id !== sessionId) return [];
  return [{ turn: 2, seq: 41, prompt: 'make it dark', files: { count: 1, restorable: 1 } }].slice(0, limit);
};
const candidatesHandler = createCandidatesHandler({ listTurns, trustedHosts: () => [] });

res = response();
await candidatesHandler(request({ sessionId }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), {
  ok: true,
  turns: [{ turn: 2, seq: 41, prompt: 'make it dark', files: { count: 1, restorable: 1 } }],
});

res = response();
await candidatesHandler(request({ sessionId }, { method: 'GET' }), res);
assert.equal(res.status, 405);

res = response();
await candidatesHandler(request({ sessionId: 'x' }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body).turns, []);

res = response();
await candidatesHandler(request({}), res);
assert.equal(res.status, 400);

res = response();
await candidatesHandler(request({ sessionId }, { host: 'example.com', origin: 'http://example.com' }), res);
assert.equal(res.status, 403);

// --- in-place rewind ----------------------------------------------------
const executed = [];
const inplaceHandler = createInplaceHandler({
  describe: async (id, seq) => {
    if (id !== sessionId) throw Object.assign(new Error('not live'), { status: 409 });
    if (seq !== 11) throw Object.assign(new Error('only your own messages'), { code: 'not-a-user-message' });
    return { targetSeq: 11, surfaceStart: 11, surfaceEnd: 41, prompt: 'make it dark', turn: 2 };
  },
  execute: async (id, seq, restoreFiles) => {
    if (seq !== 11) throw Object.assign(new Error('only your own messages'), { code: 'not-a-user-message' });
    executed.push({ id, seq, restoreFiles });
    return { markerSeq: 50, targetSeq: seq, prompt: 'make it dark', turn: 2, hiddenFromSeq: 11, hiddenFromTurn: 2 };
  },
  trustedHosts: () => [],
});

// dryRun plans without executing
res = response();
await inplaceHandler(request({ sessionId, seq: 11, dryRun: true }), res);
assert.equal(res.status, 200);
assert.equal(JSON.parse(res.body).dryRun, true);
assert.deepEqual(executed, []);

// execute appends + reports the cut
res = response();
await inplaceHandler(request({ sessionId, seq: 11 }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), {
  ok: true, markerSeq: 50, targetSeq: 11, prompt: 'make it dark', turn: 2, hiddenFromSeq: 11, hiddenFromTurn: 2,
});
assert.deepEqual(executed, [{ id: sessionId, seq: 11, restoreFiles: true }]);

// a planning refusal is a 409 with a code, not a 500
executed.length = 0;
res = response();
await inplaceHandler(request({ sessionId, seq: 12 }), res);
assert.equal(res.status, 409);
assert.equal(JSON.parse(res.body).code, 'not-a-user-message');

// gates
res = response();
await inplaceHandler(request({ sessionId }, {}), res);
assert.equal(res.status, 400);
res = response();
await inplaceHandler(request({ sessionId, seq: -1 }), res);
assert.equal(res.status, 400);
res = response();
await inplaceHandler(request({ sessionId, seq: 11 }, { host: 'evil.example', origin: 'http://evil.example' }), res);
assert.equal(res.status, 403);

// --- cuts ----------------------------------------------------------------
const cutsHandler = createCutsHandler({
  cutsOf: async (id) => (id === sessionId ? { hiddenFromSeq: 11, hiddenFromTurn: 2 } : { hiddenFromSeq: null, hiddenFromTurn: null }),
  trustedHosts: () => [],
});
res = response();
await cutsHandler(request({ sessionId }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), { ok: true, hiddenFromSeq: 11, hiddenFromTurn: 2 });
res = response();
await cutsHandler(request({}), res);
assert.equal(res.status, 400);

// --- restore -------------------------------------------------------------
res = response();
await restoreHandler(request({ sessionId, turn: 2 }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), {
  ok: true,
  turn: 2,
  results: [{ path: 'src/main.ts', status: 'restored' }],
});
assert.deepEqual(restored, [file]);

// a client cannot name a path that the archive did not record
restored.length = 0;
res = response();
await restoreHandler(request({ sessionId, turn: 2, paths: ['C:/Windows/System32/config/SAM'] }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body).results, []);
assert.deepEqual(restored, []);

// an unknown turn is refused, and no file is touched
restored.length = 0;
res = response();
await restoreHandler(request({ sessionId, turn: 9 }), res);
assert.equal(res.status, 409);
assert.deepEqual(restored, []);

// a Turn with no captured files answers with an empty result, not an error
res = response();
await restoreHandler(request({ sessionId, turn: 2, paths: [] }), res);
assert.equal(res.status, 200);

console.log(`route smoke: all assertions passed (${PLAN_PATH}, ${RESTORE_PATH})`);

await archive.close();
await rm(root, { recursive: true, force: true });
