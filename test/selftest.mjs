/**
 * Self-test for the Host half's pure logic: Turn location, prompt extraction,
 * the durable archive, and the per-file restorer. Runs outside the plugin
 * package so nothing here ships.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isInsideGitMetadata, createArchive } from '../src/lib/archive.js';
import { restoreFile } from '../src/lib/restore.js';
import { locateTurn, userPromptOf } from '../src/plugin.js';

const events = [
  { seq: 0, type: 'session', data: {} },
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime noise' }] } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first prompt' }] } },
  { seq: 4, type: 'tool/call', data: { turn: 1 } },
  { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 6, type: 'turn/start', data: { turn: 2 } },
  { seq: 7, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second prompt' }, { type: 'text', text: 'with two blocks' }] } },
  { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
];

// --- turn location -------------------------------------------------------
assert.deepEqual(locateTurn(events, { turn: 1 }), { turn: 1, endSeq: 5 });
assert.deepEqual(locateTurn(events, { turn: 2 }), { turn: 2, endSeq: 9 });
// The client sends the closing message seq when the Turn object has no `end`.
assert.deepEqual(locateTurn(events, { seq: 8 }), { turn: 2, endSeq: 9 });
assert.deepEqual(locateTurn(events, { seq: 4 }), { turn: 1, endSeq: 5 });
assert.equal(locateTurn(events, { turn: 7 }), null);
assert.equal(locateTurn(events, {}), null);

// --- prompt extraction ---------------------------------------------------
assert.equal(userPromptOf(events, 1), 'first prompt');
assert.equal(userPromptOf(events, 2), 'second prompt\nwith two blocks');
assert.equal(userPromptOf(events, 3), null);

// --- archive -------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'rewind-test-'));
const archiveDir = join(root, 'archive');
const workDir = join(root, 'work');
await mkdir(workDir, { recursive: true });

const existing = join(workDir, 'app.js');
const binary = join(workDir, 'logo.bin');
const created = join(workDir, 'new.txt');
await writeFile(existing, 'const before = 1;\n', 'utf8');
await writeFile(binary, Buffer.from([0, 1, 2, 255, 0]), 'binary');

const warnings = [];
const archive = createArchive({ directory: archiveDir, warn: (error) => warnings.push(error) });
const sessionId = 'session-test-1';

const capturedExisting = await archive.record({
  sessionId, turn: 1, cwd: workDir, absolute: existing, displayPath: 'app.js',
});
assert.equal(capturedExisting.existed, true);
assert.equal(capturedExisting.text, true);
assert.equal(typeof capturedExisting.blob, 'string');

const capturedBinary = await archive.record({
  sessionId, turn: 1, cwd: workDir, absolute: binary, displayPath: 'logo.bin',
});
assert.equal(capturedBinary.existed, true);
assert.equal(capturedBinary.text, false);

const capturedCreated = await archive.record({
  sessionId, turn: 1, cwd: workDir, absolute: created, displayPath: 'new.txt',
});
assert.equal(capturedCreated.existed, false);
assert.equal(capturedCreated.blob, null);

// dedupe inside one Turn, and .git is never recorded
assert.equal(await archive.record({ sessionId, turn: 1, absolute: existing, displayPath: 'app.js' }), null);
assert.equal(await archive.record({
  sessionId, turn: 1, absolute: join(workDir, '.git', 'HEAD'), displayPath: '.git/HEAD',
}), null);
assert.equal(isInsideGitMetadata(join(workDir, '.git', 'HEAD')), true);
assert.equal(isInsideGitMetadata(join(workDir, 'git', 'HEAD')), false);
assert.equal(isInsideGitMetadata(join(workDir, '.gitignore')), false);
assert.equal(isInsideGitMetadata(join(workDir, 'src', 'app.js')), false);

const entry = await archive.get(sessionId, 1);
assert.equal(entry.files.length, 3);
assert.deepEqual(await archive.readBlob(capturedExisting.blob), Buffer.from('const before = 1;\n'));
assert.deepEqual(await archive.readBlob(capturedBinary.blob), Buffer.from([0, 1, 2, 255, 0]));
assert.equal(await archive.readBlob('../../etc/passwd'), null);
assert.equal(await archive.get('nobody', 1), null);
await archive.markRestored(sessionId, 1);
assert.equal(typeof (await archive.get(sessionId, 1)).restoredAt, 'number');
await archive.close();

// persistence across a reload
const reopened = createArchive({ directory: archiveDir });
assert.equal((await reopened.get(sessionId, 1)).files.length, 3);
await reopened.close();
assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.map(String).join(', ')}`);

// --- restore -------------------------------------------------------------
const archive2 = createArchive({ directory: join(root, 'archive2') });
const fsWrites = [];
const fsService = {
  resolve: async (path) => ({ targetKey: path, displayPath: path }),
  contains: (parent, child) => child.targetKey === parent.targetKey
    || child.targetKey.startsWith(`${parent.targetKey}\\`)
    || child.targetKey.startsWith(`${parent.targetKey}/`),
  stat: async (target) => {
    try {
      await fsStat(target.targetKey);
      return { version: 'v-current', type: 'file', size: 1 };
    } catch {
      return undefined;
    }
  },
  writeText: async (target, content, expected, signal, policy) => {
    fsWrites.push({ target: target.targetKey, content, expected, policy });
    await writeFile(target.targetKey, content, 'utf8');
  },
};

const before = await archive2.record({
  sessionId: 's2', turn: 4, absolute: existing, displayPath: 'app.js',
});
await writeFile(existing, 'const after = 2;\n', 'utf8');
const restored = await restoreFile({ fsService, archive: archive2, file: before, workspaceRoot: workDir });
assert.deepEqual(restored, { path: 'app.js', status: 'restored' });
assert.equal(await readFile(existing, 'utf8'), 'const before = 1;\n');
assert.deepEqual(fsWrites[0].expected, { kind: 'replaceIfVersion', version: 'v-current' });
// A plugin-originated write needs an explicit policy; inside the Turn's own
// workspace the narrower mode is used.
assert.deepEqual(fsWrites[0].policy, { mode: 'workspace-write', workspaceRoot: workDir });

// Outside that workspace the restore has to use the wider mode.
const outside = join(root, 'outside.txt');
await writeFile(outside, 'outside before\n', 'utf8');
const outsideRecord = await archive2.record({ sessionId: 's2', turn: 4, absolute: outside, displayPath: 'outside.txt' });
fsWrites.length = 0;
await restoreFile({ fsService, archive: archive2, file: outsideRecord, workspaceRoot: workDir });
assert.deepEqual(fsWrites[0].policy, { mode: 'danger-full-access', workspaceRoot: workDir });

// absent pre-image -> createIfAbsent
fsWrites.length = 0;
await rm(existing, { force: true });
const missingTarget = await restoreFile({ fsService, archive: archive2, file: before });
assert.deepEqual(missingTarget, { path: 'app.js', status: 'restored' });
assert.deepEqual(fsWrites[0].expected, { kind: 'createIfAbsent' });

// binary pre-image bypasses the text path and writes exact bytes
await writeFile(binary, Buffer.from([9, 9, 9]), 'binary');
const binBefore = await archive2.record({ sessionId: 's2', turn: 4, absolute: binary, displayPath: 'logo.bin' });
await writeFile(binary, Buffer.from([7, 7]), 'binary');
await restoreFile({ fsService, archive: archive2, file: binBefore });
assert.deepEqual([...await readFile(binary)], [9, 9, 9]);

// a file the Turn created is removed
const createdFile = join(workDir, 'made.txt');
const madeRecord = await archive2.record({ sessionId: 's2', turn: 4, absolute: createdFile, displayPath: 'made.txt' });
assert.equal(madeRecord.existed, false);
await writeFile(createdFile, 'made\n', 'utf8');
const observations = [];
const removed = await restoreFile({
  fsService,
  archive: archive2,
  file: madeRecord,
  workspaceRoot: workDir,
  syncObservation: async (absolute, observation) => observations.push({ absolute, observation }),
});
assert.deepEqual(removed, { path: 'made.txt', status: 'deleted' });
await assert.rejects(readFile(createdFile, 'utf8'), (error) => error.code === 'ENOENT');
// The removal is published as an observation so DSH's fs policy does not keep
// believing the file still exists.
assert.deepEqual(observations, [{ absolute: createdFile, observation: { kind: 'absent' } }]);

// A binary restore publishes the re-read version as a present observation.
// (NUL/0xFF bytes so the pre-image is genuinely not UTF-8.)
await writeFile(binary, Buffer.from([0, 255, 1]), 'binary');
const binBefore2 = await archive2.record({ sessionId: 's2', turn: 5, absolute: binary, displayPath: 'logo.bin' });
assert.equal(binBefore2.text, false);
await writeFile(binary, Buffer.from([6, 6]), 'binary');
const binaryObservations = [];
await restoreFile({
  fsService,
  archive: archive2,
  file: binBefore2,
  workspaceRoot: workDir,
  syncObservation: async (absolute, observation) => binaryObservations.push({ absolute, observation }),
});
assert.deepEqual([...await readFile(binary)], [0, 255, 1]);
assert.deepEqual(binaryObservations, [{ absolute: binary, observation: { kind: 'present', version: 'v-current' } }]);

// a pruned/absent blob is reported, never guessed
const goneBlob = await restoreFile({
  fsService,
  archive: { readBlob: async () => null },
  file: { ...before, blob: 'a'.repeat(64) + '.bin' },
});
assert.equal(goneBlob.status, 'skipped');

await archive2.close();
await rm(root, { recursive: true, force: true });

console.log('selftest: all assertions passed');
