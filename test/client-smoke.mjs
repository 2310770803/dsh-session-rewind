/**
 * Browser-half smoke test: loads `lib/client.js` exactly as a classic script
 * with a stub module loader, a stub React, a stub slot registry and a stub
 * `fetch`, then drives the rendered control through plan -> fork and checks the
 * side effects that matter (the fork boundary, the pre-seeded draft, the opened
 * session and the restore request).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

//#region stubs
const listeners = new Map();
globalThis.document = {
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: (type) => listeners.delete(type),
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
  documentElement: { appendChild: () => {} },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window = globalThis;

async function installReact() {
  const { createRequire } = await import('node:module');
  // No React in this environment: a minimal hook store per component function is
  // enough (hook order never changes inside either component).
  const stores = new Map();
  let hooks = [];
  let cursor = 0;
  const ReactStub = {
    useState: (initial) => {
      // Capture this render's store: setters outlive the render that made them.
      const store = hooks;
      const index = cursor;
      cursor += 1;
      if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial;
      return [store[index], (next) => {
        store[index] = typeof next === 'function' ? next(store[index]) : next;
      }];
    },
    useRef: (initial) => {
      const store = hooks;
      const index = cursor;
      cursor += 1;
      if (!(index in store)) store[index] = { current: initial };
      return store[index];
    },
    useEffect: () => {
      cursor += 1;
      return undefined;
    },
  };
  const runtime = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  };
  return {
    require: (id) => {
      if (id === 'react') return ReactStub;
      if (id === 'react/jsx-runtime') return runtime;
      throw new Error(`unexpected require: ${id}`);
    },
    /** One render pass of one component: its own hook store, cursor at 0. */
    beginRender: (component) => {
      if (!stores.has(component)) stores.set(component, []);
      hooks = stores.get(component);
      cursor = 0;
    },
    resetCursor: () => {
      cursor = 0;
    },
    getHooks: () => hooks,
    createRequire,
  };
}

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ type: '#text', props: { children: node } });
    return;
  }
  if (typeof node.type !== 'object' && typeof node.type !== 'function' && typeof node.type !== 'string') return;
  if (typeof node.type === 'function') {
    // Every invocation is one render pass of that component.
    react.beginRender(node.type);
    walk(node.type({ ...node.props, key: node.key }), visit);
    return;
  }
  visit(node);
  if (node.props !== undefined && node.props.children !== undefined) walk(node.props.children, visit);
};

const findAll = (tree, predicate) => {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
};

const textOf = (tree) => {
  const parts = [];
  walk(tree, (node) => {
    if (node.type === '#text') parts.push(String(node.props.children));
  });
  return parts.join('');
};

const flush = async (times = 6) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
//#endregion

const react = await installReact();
let factory;
let moduleId;
globalThis.__ModuleLoader__ = {
  load: (entry) => {
    moduleId = entry.id;
    factory = entry.factory;
  },
};
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function(source)();
assert.equal(moduleId, 'dsh-session-rewind');
assert.equal(typeof factory, 'function');

const clientModule = factory(react.require);
assert.equal(typeof clientModule.apply, 'function');
assert.deepEqual(clientModule.inject, []);

//#region registries
const registrations = [];
const localeEntries = [];
/** Services the Client context resolves; filled before the render block. */
const services = {};
const context = {
  get: (name) => services[name],
  inject: (names, callback) => {
    const scope = {
      get: (name) => (name === 'slots' || name === 'locale' ? scopeServices[name] : undefined),
      effect: (fn) => {
        const disposer = fn();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      slots: {
        inject: (name, register) => {
          register();
        },
        register: (options, component) => {
          registrations.push({ options, component });
          return () => {};
        },
      },
      locale: {
        register: (namespace, dictionaries) => {
          localeEntries.push({ namespace, dictionaries });
          return () => {};
        },
        bind: (namespace) => (key) => `${namespace}.${key}`,
      },
    };
    const scopeServices = { slots: scope.slots, locale: scope.locale };
    callback(scope);
    return scope;
  },
};
clientModule.apply(context);
assert.equal(registrations.length, 2);
const registration = registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail');
const headerRegistration = registrations.find((entry) => entry.options.name === 'conversation.session.header.actions');
assert.ok(registration !== undefined, 'turn-tail registration');
assert.ok(headerRegistration !== undefined, 'header registration');
assert.equal(headerRegistration.options.id, 'session-rewind');
assert.equal(headerRegistration.options.order, -1);
assert.equal(registration.options.name, 'conversation.chat.turnTail');
assert.equal(registration.options.id, 'session-rewind');
assert.equal(registration.options.order, -1);
assert.equal(registration.options.inject().tr('button.label'), 'session-rewind.button.label');
assert.equal(localeEntries.length, 1);
assert.equal(localeEntries[0].namespace, 'session-rewind');
assert.equal(typeof localeEntries[0].dictionaries.zh, 'object');
assert.equal(typeof localeEntries[0].dictionaries.en, 'object');
//#endregion

//#region render, plan, fork
const childId = 'session-child-9';
const fetchCalls = [];
globalThis.fetch = async (route, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ route, body });
  if (route === '/api/session-rewind.plan') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        turn: 3,
        seq: 12,
        prompt: '把登录页改成深色主题',
        files: [
          { path: 'E:/work/app/login.tsx', displayPath: 'app/login.tsx', action: 'restore', size: 42 },
          { path: 'E:/work/app/new.css', displayPath: 'app/new.css', action: 'delete', size: 8 },
        ],
      }),
    };
  }
  if (route === '/api/session-rewind.restore') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        turn: 3,
        results: (body.paths ?? []).map((path) => ({ path, status: 'restored' })),
      }),
    };
  }
  if (route === '/api/session-rewind.candidates') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        turns: [
          { turn: 2, seq: 28, userSeq: 21, prompt: '第二条提问：把登录页改成深色主题', files: { count: 2, restorable: 2 } },
          { turn: 1, seq: 12, userSeq: 5, prompt: '第一条提问：初始化项目', files: { count: 0, restorable: 0 } },
        ],
      }),
    };
  }
  throw new Error(`unexpected route ${route}`);
};

const forkCalls = [];
const opened = [];
const sessionsService = {
  fork: async (request) => {
    forkCalls.push(request);
    return childId;
  },
};
const workspaceService = {
  openSession: (target) => opened.push(target),
};
services.sessions = sessionsService;
services.uiWorkspace = workspaceService;
const props = {
  sessionId: 'session-parent-1',
  turn: { turn: 3, end: { seq: 12 } },
  seq: 12,
  useAccess: () => true,
  ctx: {
    get: (name) => {
      if (name === 'sessions') return sessionsService;
      if (name === 'uiWorkspace') return workspaceService;
      return undefined;
    },
  },
};

// No target -> nothing renders.
react.resetCursor();
const emptyTree = registration.component({ ...props, turn: undefined, seq: undefined });
assert.deepEqual(findAll(emptyTree, (node) => node.type === 'button'), []);

react.resetCursor();
let tree = registration.component(props);
let triggers = findAll(tree, (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindTrigger'));
assert.equal(triggers.length, 1);
assert.match(textOf(tree), /session-rewind\.button\.label/u);

// Open the panel: it must ask the Host for a plan first.
triggers[0].props.onClick();
await flush();
assert.equal(fetchCalls.length, 1);
assert.deepEqual(fetchCalls[0].body, { sessionId: 'session-parent-1', turn: 3 });
assert.equal(fetchCalls[0].route, '/api/session-rewind.plan');

react.resetCursor();
tree = registration.component(props);
assert.match(textOf(tree), /session-rewind\.panel\.title/u);
assert.match(textOf(tree), /app\/login\.tsx/u);
assert.match(textOf(tree), /app\/new\.css/u);
assert.match(textOf(tree), /session-rewind\.panel\.deleteOne/u);

// Rewind: restore the checked files, fork at the Turn boundary, seed the draft
// and open the child session.
const primary = findAll(tree, (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindPrimary'));
assert.equal(primary.length, 1);
primary[0].props.onClick();
await flush(12);

assert.equal(fetchCalls.length, 2);
assert.equal(fetchCalls[1].route, '/api/session-rewind.restore');
assert.deepEqual(fetchCalls[1].body.paths, ['E:/work/app/login.tsx', 'E:/work/app/new.css']);
assert.deepEqual(forkCalls, [{ sessionId: 'session-parent-1', atSeq: 12, increaseTitle: true }]);
assert.deepEqual(opened, [childId]);
const draft = JSON.parse(store.get(`dsh.conversation.${childId}`));
assert.deepEqual(draft.draft, { text: '把登录页改成深色主题', references: [] });

// Unchecking a file keeps it out of the restore request.
react.resetCursor();
tree = registration.component(props);
const boxes = findAll(tree, (node) => node.type === 'input');
assert.equal(boxes.length, 2);
boxes[0].props.onChange();
react.resetCursor();
tree = registration.component(props);
const restoreOnly = findAll(tree, (node) => node.type === 'button'
  && String(node.props.children ?? '') === 'session-rewind.action.restore');
assert.equal(restoreOnly.length, 1);
fetchCalls.length = 0;
restoreOnly[0].props.onClick();
await flush(10);
assert.deepEqual(fetchCalls[0].body.paths, ['E:/work/app/new.css']);
assert.equal(forkCalls.length, 1);
//#endregion

//#region failure paths
// A session with no fork boundary renders nothing at all.
react.resetCursor();
const noBoundary = registration.component({ ...props, turn: { turn: 3 }, seq: undefined });
assert.deepEqual(findAll(noBoundary, (node) => node.type === 'button'), []);
//#endregion

//#region session-header entry: candidate list -> mode -> fork
const headerChildId = 'session-child-header';
fetchCalls.length = 0;
forkCalls.length = 0;
opened.length = 0;
sessionsService.fork = async (request) => {
  forkCalls.push(request);
  return headerChildId;
};

const headerProps = {
  sessionId: 'session-parent-1',
  useAccess: () => true,
  ctx: {
    get: (name) => {
      if (name === 'sessions') return sessionsService;
      if (name === 'uiWorkspace') return workspaceService;
      return undefined;
    },
  },
};

// The trigger renders even with nothing loaded yet.
// `renderHeader()` forces one full render pass (the tree is built lazily).
const renderHeader = () => {
  const tree = headerRegistration.component(headerProps);
  findAll(tree, () => false);
  return tree;
};
let headerTree = renderHeader();
let headerTrigger = findAll(headerTree, (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindHeaderBtn'));
assert.equal(headerTrigger.length, 1);

// Opening it asks the Host for the finished Turns.
headerTrigger[0].props.onClick();
await flush();
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].route, '/api/session-rewind.candidates');
assert.deepEqual(fetchCalls[0].body, { sessionId: 'session-parent-1' });
headerTree = renderHeader();

let headerRounds = findAll(headerTree, (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindRound'));
assert.equal(headerRounds.length, 2, 'two candidate rounds');
assert.match(textOf(headerTree), /session-rewind\.list\.round/u);
assert.match(textOf(headerTree), /第二条提问/u);
assert.match(textOf(headerTree), /session-rewind\.list\.files/u);

// Choosing a round switches to the mode step: in-place is the primary action
// and branching is still offered.
headerRounds[0].props.onClick();
assert.match(textOf(headerTree), /session-rewind\.mode\.inplace/u);
assert.match(textOf(headerTree), /session-rewind\.mode\.inplaceFiles/u);
assert.match(textOf(headerTree), /session-rewind\.mode\.fork/u);
assert.match(textOf(headerTree), /session-rewind\.mode\.back/u);

// Branch mode forks at that round's committed turn end, with no file write.
const headerFork = findAll(headerTree, (node) => node.type === 'button'
  && String(node.props.children ?? '') === 'session-rewind.mode.fork');
assert.equal(headerFork.length, 1);
headerFork[0].props.onClick();
await flush(12);
assert.deepEqual(forkCalls, [{ sessionId: 'session-parent-1', atSeq: 28, increaseTitle: true }]);
assert.deepEqual(opened, [headerChildId]);
assert.deepEqual(
  JSON.parse(store.get(`dsh.conversation.${headerChildId}`)).draft,
  { text: '第二条提问：把登录页改成深色主题', references: [] },
);
assert.equal(fetchCalls.filter((call) => call.route === '/api/session-rewind.restore').length, 0);

// "Rewind and restore" reaches the restore route first, then forks.
fetchCalls.length = 0;
forkCalls.length = 0;
opened.length = 0;
headerTrigger = findAll(renderHeader(), (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindHeaderBtn'));
headerTrigger[0].props.onClick();
await flush();
headerTree = renderHeader();
headerRounds = findAll(headerTree, (node) => node.type === 'button'
  && String(node.props.className ?? '').includes('dshSessionRewindRound'));
assert.equal(headerRounds.length, 2);
headerRounds[0].props.onClick();
headerTree = renderHeader();
const restoreBoth = findAll(headerTree, (node) => node.type === 'button'
  && String(node.props.children ?? '') === 'session-rewind.mode.inplaceFiles');
assert.equal(restoreBoth.length, 1);
// In-place mode without a mount-less bridge must degrade to a visible error
// instead of throwing (the DOM bridge only exists in a real page).
restoreBoth[0].props.onClick();
await flush(12);
assert.match(textOf(headerTree), /session-rewind\.notice\.unavailable/u);
assert.equal(forkCalls.length, 0);
//#endregion

console.log('client smoke: all assertions passed');
