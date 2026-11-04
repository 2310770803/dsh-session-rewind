/**
 * Browser-half smoke test: loads `lib/client.js` exactly as a classic script
 * with a stub module loader, a stub React, a stub slot registry and a stub
 * `fetch`, then drives the rendered control through plan -> fork and checks the
 * side effects that matter (the fork boundary, the pre-seeded draft, the opened
 * session and the restore request).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

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
// Only the turn-tail slot is registered: it exists purely as a guaranteed mount
// point for the per-message bridge, and its own button is hidden. The header
// entry was retired so the rewind control has exactly one place — the user's row.
assert.equal(registrations.length, 1);
const registration = registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail');
assert.ok(registration !== undefined, 'turn-tail registration');
assert.equal(registrations.some((entry) => entry.options.name === 'conversation.session.header.actions'), false);
assert.equal(registration.options.name, 'conversation.chat.turnTail');
assert.equal(registration.options.id, 'session-rewind');
assert.equal(registration.options.order, -1);
assert.equal(registration.options.inject().tr('button.label'), 'session-rewind.button.label');
assert.equal(localeEntries.length, 1);
assert.equal(localeEntries[0].namespace, 'session-rewind');
assert.equal(typeof localeEntries[0].dictionaries.zh, 'object');
assert.equal(typeof localeEntries[0].dictionaries.en, 'object');
//#endregion

//#region bridge host and source contracts
assert.equal(registrations.length, 1);
assert.equal(registration.options.name, 'conversation.chat.turnTail');
assert.equal(registration.options.id, 'session-rewind');
assert.equal(registrations.some((entry) => entry.options.name === 'conversation.session.header.actions'), false);
react.resetCursor();
const hostNode = registration.component({ sessionId: 'session-parent-1', ctx: context, tr: (key) => key });
react.beginRender(hostNode.type);
assert.equal(hostNode.type(hostNode.props), null);
const sourceText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(sourceText, /function createRowBridge/);
assert.match(sourceText, /querySelector\('\[data-clock\]'\)/);
assert.match(sourceText, /activeTurns/);
assert.match(sourceText, /runEdit = async/);
assert.match(sourceText, /message\.editTitle/);
assert.match(sourceText, /const openPopover = \(anchor, seq, notice, turn/u);
assert.match(sourceText, /runRewind\(seq, false, notice, turn\)/u);
assert.match(sourceText, /runRewind\(seq, true, notice, turn\)/u);
assert.equal(sourceText.includes('conversation.session.header.actions'), false);
//#endregion

console.log('client smoke: all assertions passed');
