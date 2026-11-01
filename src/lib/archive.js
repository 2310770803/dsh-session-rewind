/**
 * Durable archive of the pre-Turn content of every workspace file a Turn
 * mutates.
 *
 * The Harness session log is append-only, so "roll the files back to how they
 * were before that Turn" needs its own record. This module owns that record:
 * one JSON index plus a content-addressed blob per distinct pre-image, both
 * under `$DSH_HOME/plugin-data/dsh-session-rewind`.
 *
 *   index.json          { version, turns: { "<sessionId>|<turn>": TurnRecord } }
 *   blobs/<sha256>.bin  the bytes exactly as they were before the mutation
 *
 * Every failure is contained: a snapshot that cannot be written or read is
 * reported through `warn` and treated as absent, because losing one snapshot
 * costs one restore, while throwing here would sit inside a filesystem write.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ARCHIVE_VERSION = 1;

/** Largest pre-image kept per file; larger files keep metadata only. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Largest number of distinct files recorded per Turn. */
export const MAX_FILES_PER_TURN = 200;

/** Turns kept across all sessions before the oldest ones are dropped. */
export const MAX_TURNS = 400;

const PRUNE_EVERY = 25;
const BLOB_NAME = /^[0-9a-f]{64}\.bin$/u;

/**
 * Resolve the archive directory from the Host environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function archiveDirectory(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const home = configured === '' ? join(homedir(), '.dsh') : configured;
  return join(home, 'plugin-data', 'dsh-session-rewind');
}

/**
 * @param {string} sessionId
 * @param {number} turn
 * @returns {string}
 */
export function turnKey(sessionId, turn) {
  return `${String(sessionId)}|${String(turn)}`;
}

const noop = () => {};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when `path` is inside a `.git` directory or is the `.git` entry itself.
 * Restoring those bytes behind Git's back corrupts the repository, so they are
 * never recorded and therefore never restored.
 * @param {string} path
 * @returns {boolean}
 */
export function isInsideGitMetadata(path) {
  if (typeof path !== 'string') return false;
  return /(?:^|[\\/])\.git(?:[\\/]|$)/u.test(path);
}

function normalizeFile(file) {
  if (!isRecord(file)) return null;
  if (typeof file.path !== 'string' || file.path === '') return null;
  if (typeof file.displayPath !== 'string' || file.displayPath === '') return null;
  const blob = typeof file.blob === 'string' && BLOB_NAME.test(file.blob) ? file.blob : null;
  const reason = typeof file.reason === 'string' && file.reason !== '' ? file.reason : undefined;
  return {
    path: file.path,
    displayPath: file.displayPath,
    existed: file.existed === true,
    text: file.text === true,
    blob,
    size: Number.isFinite(file.size) ? file.size : 0,
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeTurn(value) {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return null;
  if (!Number.isInteger(value.turn)) return null;
  const files = [];
  if (Array.isArray(value.files)) {
    for (const raw of value.files) {
      const file = normalizeFile(raw);
      if (file !== null) files.push(file);
    }
  }
  const restoredAt = Number.isFinite(value.restoredAt) ? value.restoredAt : undefined;
  return {
    sessionId: value.sessionId,
    turn: value.turn,
    at: Number.isFinite(value.at) ? value.at : 0,
    cwd: typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined,
    files,
    ...(restoredAt === undefined ? {} : { restoredAt }),
  };
}

function parseIndex(raw) {
  const empty = { version: ARCHIVE_VERSION, turns: {} };
  if (typeof raw !== 'string' || raw === '') return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || parsed.version !== ARCHIVE_VERSION || !isRecord(parsed.turns)) return empty;
  const turns = {};
  for (const [key, value] of Object.entries(parsed.turns)) {
    const turn = normalizeTurn(value);
    if (turn !== null) turns[key] = turn;
  }
  return { version: ARCHIVE_VERSION, turns };
}

/**
 * A single-byte-level copy of one file, taken before a Turn mutated it.
 * @typedef {object} CapturedFile
 * @property {string} path        absolute path on this machine
 * @property {string} displayPath path as DSH shows it
 * @property {boolean} existed    false when the Turn created the file
 * @property {boolean} text       true when the pre-image is valid UTF-8
 * @property {string | null} blob content-addressed blob name, when captured
 * @property {number} size        pre-image size in bytes
 * @property {string} [reason]    why no content was captured
 */

/**
 * Open (or create) the archive.
 *
 * @param {{
 *   directory?: string,
 *   warn?: (error: unknown) => void,
 *   readStats?: (path: string) => Promise<{ isFile(): boolean, size: number }>,
 *   readBytes?: (path: string) => Promise<Buffer>,
 * }} [options]
 * @returns {{
 *   directory: string,
 *   record: (input: { sessionId: string, turn: number, cwd?: string, absolute: string, displayPath: string }) => Promise<CapturedFile | null>,
 *   get: (sessionId: string, turn: number) => Promise<object | null>,
 *   markRestored: (sessionId: string, turn: number) => Promise<void>,
 *   readBlob: (name: string | null) => Promise<Buffer | null>,
 *   close: () => Promise<void>,
 * }}
 */
export function createArchive({
  directory = archiveDirectory(),
  warn = () => {},
  readStats = (path) => stat(path),
  readBytes = (path) => readFile(path),
} = {}) {
  const indexPath = join(directory, 'index.json');
  const blobDir = join(directory, 'blobs');

  /** @type {{ version: number, turns: Record<string, any> } | undefined} */
  let index;
  /** @type {Promise<any> | undefined} */
  let loading;
  let queue = Promise.resolve();
  let writes = 0;
  let closed = false;

  const report = (error) => {
    try {
      warn(error);
    } catch {
      /* diagnostics must never escalate */
    }
  };

  const load = async () => {
    if (index !== undefined) return index;
    loading ??= (async () => {
      try {
        await mkdir(blobDir, { recursive: true });
      } catch (error) {
        report(error);
      }
      let raw = null;
      try {
        raw = await readFile(indexPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') report(error);
      }
      index = parseIndex(raw);
      return index;
    })();
    return loading;
  };

  const writeIndex = async (state) => {
    const payload = JSON.stringify(state);
    try {
      await mkdir(directory, { recursive: true });
      const temp = `${indexPath}.${String(process.pid)}.tmp`;
      await writeFile(temp, payload, 'utf8');
      await rename(temp, indexPath);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const collectBlobs = async (state) => {
    const referenced = new Set();
    for (const turn of Object.values(state.turns)) {
      for (const file of turn.files) {
        if (typeof file.blob === 'string') referenced.add(file.blob);
      }
    }
    let names;
    try {
      names = await readdir(blobDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!BLOB_NAME.test(name) || referenced.has(name)) continue;
      try {
        await unlink(join(blobDir, name));
      } catch (error) {
        report(error);
      }
    }
  };

  const prune = async (state) => {
    const keys = Object.keys(state.turns);
    if (keys.length <= MAX_TURNS) return;
    keys.sort((left, right) => (state.turns[left].at ?? 0) - (state.turns[right].at ?? 0));
    for (const key of keys.slice(0, keys.length - MAX_TURNS)) delete state.turns[key];
    await writeIndex(state);
    await collectBlobs(state);
  };

  const save = async (state) => {
    const saved = await writeIndex(state);
    if (!saved) return;
    writes += 1;
    if (writes % PRUNE_EVERY === 0) await prune(state);
  };

  const isUtf8Text = (bytes) => {
    if (bytes.includes(0)) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  };

  const readPreImage = async (absolute, displayPath) => {
    let info;
    try {
      info = await readStats(absolute);
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { path: absolute, displayPath, existed: false, text: false, blob: null, size: 0 };
      }
      report(error);
      return null;
    }
    if (typeof info?.isFile === 'function' && !info.isFile()) return null;
    const size = Number.isFinite(info?.size) ? info.size : 0;
    if (size > MAX_FILE_BYTES) {
      return { path: absolute, displayPath, existed: true, text: false, blob: null, size, reason: 'too-large' };
    }
    let bytes;
    try {
      bytes = await readBytes(absolute);
    } catch (error) {
      report(error);
      return { path: absolute, displayPath, existed: true, text: false, blob: null, size, reason: 'unreadable' };
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const name = `${createHash('sha256').update(buffer).digest('hex')}.bin`;
    let blob = null;
    try {
      await mkdir(blobDir, { recursive: true });
      await writeFile(join(blobDir, name), buffer);
      blob = name;
    } catch (error) {
      report(error);
    }
    return {
      path: absolute,
      displayPath,
      existed: true,
      text: isUtf8Text(buffer),
      blob,
      size: buffer.byteLength,
      ...(blob === null ? { reason: 'unreadable' } : {}),
    };
  };

  const recordNow = async ({ sessionId, turn, cwd, absolute, displayPath }) => {
    if (closed) return null;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!Number.isInteger(turn)) return null;
    if (typeof absolute !== 'string' || absolute === '') return null;
    if (isInsideGitMetadata(absolute)) return null;
    const state = await load();
    const key = turnKey(sessionId, turn);
    let entry = state.turns[key];
    if (entry === undefined) {
      entry = {
        sessionId,
        turn,
        at: Date.now(),
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        files: [],
      };
      state.turns[key] = entry;
    }
    if (entry.files.some((file) => file.path === absolute)) return null;
    if (entry.files.length >= MAX_FILES_PER_TURN) return null;
    const captured = await readPreImage(absolute, displayPath);
    if (captured === null) return null;
    entry.files.push(captured);
    await save(state);
    return captured;
  };

  /** Mutations run one at a time so concurrent writes cannot interleave. */
  const serialize = (job) => {
    const run = queue.then(job, job);
    queue = run.then(noop, noop);
    return run;
  };

  return {
    directory,

    record(input) {
      return serialize(() => recordNow(input));
    },

    async get(sessionId, turn) {
      if (closed) return null;
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      if (!Number.isInteger(turn)) return null;
      const state = await load();
      return state.turns[turnKey(sessionId, turn)] ?? null;
    },

    /** Read-only totals for diagnostics. */
    async stats() {
      if (closed) return { turns: 0, files: 0 };
      const state = await load();
      let files = 0;
      for (const turn of Object.values(state.turns)) files += Array.isArray(turn.files) ? turn.files.length : 0;
      return { turns: Object.keys(state.turns).length, files };
    },

    async markRestored(sessionId, turn) {
      if (closed) return;
      await serialize(async () => {
        const state = await load();
        const entry = state.turns[turnKey(sessionId, turn)];
        if (entry === undefined) return;
        entry.restoredAt = Date.now();
        await save(state);
      });
    },

    async readBlob(name) {      if (typeof name !== 'string' || !BLOB_NAME.test(name)) return null;
      try {
        return await readFile(join(blobDir, name));
      } catch (error) {
        report(error);
        return null;
      }
    },

    async close() {
      closed = true;
      await queue.catch(noop);
    },
  };
}
