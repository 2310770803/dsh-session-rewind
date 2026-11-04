import assert from 'node:assert/strict';

import { executeEdit } from '../src/lib/inplace.js';
import { MARKER_SOURCE_KIND } from '../src/lib/surface.js';

const events = [
  { seq: 0, type: 'session', data: {} },
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  {
    seq: 2,
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '原始提示词' }],
    },
  },
];
const surface = { nodes: [1, 2], replaceGeneration: 0, contentGeneration: 0 };
const session = {
  surface,
  snapshotEvents: () => events,
  append(type, data, options) {
    const event = {
      seq: events.length,
      type,
      data,
      ...options,
    };
    events.push(event);
    surface.nodes = surface.nodes.slice(0, surface.nodes.indexOf(options.surfaceOp.startSeq)).concat(event.seq);
    surface.replaceGeneration += 1;
    surface.contentGeneration += 1;
    return event;
  },
};
const agent = {
  status: 'running',
  session,
  cancel() {
    this.status = 'idle';
  },
};
const ctx = {
  get(name) {
    return name === 'agents' ? { get: (id) => (id === 'session-edit' ? agent : undefined) } : undefined;
  },
};

const result = await executeEdit({
  ctx,
  sessionId: 'session-edit',
  seq: 2,
  readEvents: async () => events,
  timeoutMs: 100,
});

assert.equal(agent.status, 'idle', 'the active generation is stopped before replacement');
assert.equal(result.prompt, '原始提示词');
assert.equal(result.targetSeq, 2);
assert.equal(result.turn, 1);
assert.deepEqual(result.hiddenTurns, [1]);
assert.equal(result.markerSeq, 3);
assert.equal(events[3].data.source.kind, MARKER_SOURCE_KIND);
assert.deepEqual(events[3].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 });
assert.deepEqual(surface.nodes, [1, 3]);
console.log('edit smoke: active Turn is cancelled and replaced without file restore');
