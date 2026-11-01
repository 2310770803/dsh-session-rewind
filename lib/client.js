/*
 * DSH client-module artifact: the rewind control in the Chat turn tail.
 *
 * Shipped in the loader's closure-factory format so a local checkout installs
 * with no build step and no third-party build dependency.
 *
 * Contract notes (verified against the DSH Web client):
 *  - `conversation.chat.turnTail` is a `kind: "list"`, `scope: "session"` slot
 *    that renders feature contributions immediately before a finished Turn's
 *    action row. Its slot props arrive as owner props and override the standard
 *    kit, so `turn` / `seq` are the Turn's own values, and the session-scoped
 *    standard kit supplies `sessionId` plus the session hooks;
 *  - a committed Turn cannot be edited in place: the session log is append-only
 *    and branching it is the supported operation. This control therefore uses
 *    the same `sessions.fork({ sessionId, atSeq })` + `uiWorkspace.openSession`
 *    idiom as the built-in branch button, then pre-seeds the new session's
 *    composer draft (the per-session key the Conversation store reads on shell
 *    creation) with the Turn's original prompt so it can be edited and resent;
 *  - the file half is two same-origin routes served by this package's Host half.
 *
 * Everything is feature-detected: if a future DSH renames a service, the slot or
 * a hook, the affected piece degrades (or the whole control disappears) instead
 * of raising inside the boot activation audit. The factory allocates nothing at
 * top level and cannot throw, and the registration is guarded, so evaluating
 * this file can never break the page boot.
 */
(() => {
// The IIFE wrapper exists so every binding stays script-local: a revisioned
// re-load (HMR) of a classic script would otherwise die on the shared global
// lexical environment with "Identifier has already been declared".
const loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__;
if (loader === undefined || loader === null || typeof loader.load !== 'function') return;
loader.load({
  id: 'dsh-session-rewind',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const safeRequire = (id) => {
      try {
        const value = require(id);
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    };

    const React = safeRequire('react');
    const jsxRuntime = safeRequire('react/jsx-runtime');

    const jsx = jsxRuntime !== null && typeof jsxRuntime.jsx === 'function' ? jsxRuntime.jsx : null;
    const jsxs = jsxRuntime !== null && typeof jsxRuntime.jsxs === 'function' ? jsxRuntime.jsxs : null;

    /** The Chat turn tail: rendered before a finished Turn's action row. */
    const SLOT_NAME = 'conversation.chat.turnTail';
    /** The Chat header action row: the discoverable entry to the candidate list. */
    const HEADER_SLOT = 'conversation.session.header.actions';
    const PLUGIN_ID = 'session-rewind';
    const NS = 'session-rewind';
    const STYLE_ID = 'dsh-session-rewind/turn-tail';
    const PLAN_ROUTE = '/api/session-rewind.plan';
    const RESTORE_ROUTE = '/api/session-rewind.restore';
    const CANDIDATES_ROUTE = '/api/session-rewind.candidates';
    const NOTICE_MS = 5200;
    /** The Conversation store's persistence prefix; one key per session. */
    const DRAFT_STORE_KEY = 'dsh.conversation';

    //#region dictionaries
    const zh = {
      'button.label': '回退',
      'button.title': '从这个回合重新开始',
      'panel.title': '从这里重新开始',
      'panel.hint': '在该回合之后创建一份新会话；之后的消息不会出现在新会话中，原会话保持不变。',
      'panel.files': '同时恢复该回合改动的 {count} 个文件',
      'panel.planning': '正在检查可回退的内容…',
      'panel.noFiles': '该回合没有记录到文件改动',
      'panel.restoreOne': '恢复原内容',
      'panel.deleteOne': '删除（该回合新建）',
      'panel.skipOne': '无法恢复',
      'action.fork': '回退对话',
      'action.restore': '仅恢复文件',
      'action.cancel': '取消',
      'notice.restored': '已恢复 {count} 个文件',
      'notice.restoredPartial': '处理了 {ok} 个文件，{failed} 个失败',
      'notice.noFiles': '该回合没有可恢复的文件',
      'notice.failed': '回退失败',
      'notice.unavailable': '当前 DSH 版本不支持该操作',
      'notice.noSession': '会话服务不可用，无法分叉对话',
      'notice.forkUnavailable': '该回合还没有已提交的回合末尾，无法分叉',
      'header.label': '回退',
      'header.title': '回退到任意已完成的回合',
      'list.title': '选择要回退到的回合',
      'list.hint': '列表按时间倒序；↑↓ 选择，Enter 确认，Esc 关闭。',
      'list.loading': '正在读取可回退的回合…',
      'list.empty': '还没有已完成的回合可回退',
      'list.round': '第 {n} 轮',
      'list.files': '{count} 个文件',
      'mode.title': '第 {n} 轮',
      'mode.chatOnly': '仅回退对话',
      'mode.both': '回退并恢复 {count} 个文件',
      'mode.back': '返回列表',
      'mode.note': '回退会在该回合结束处新建一份会话，原会话保持不变。',
    };
    const en = {
      'button.label': 'Rewind',
      'button.title': 'Restart from this Turn',
      'panel.title': 'Restart from here',
      'panel.hint': 'Creates a new session that ends at this Turn. Later messages stay out of it and the original session is left untouched.',
      'panel.files': 'Also restore the {count} file(s) this Turn changed',
      'panel.planning': 'Checking what can be rewound…',
      'panel.noFiles': 'No file changes were recorded for this Turn',
      'panel.restoreOne': 'restore previous content',
      'panel.deleteOne': 'delete (created by this Turn)',
      'panel.skipOne': 'not restorable',
      'action.fork': 'Rewind conversation',
      'action.restore': 'Restore files only',
      'action.cancel': 'Cancel',
      'notice.restored': 'Restored {count} file(s)',
      'notice.restoredPartial': 'Handled {ok} file(s), {failed} failed',
      'notice.noFiles': 'This Turn has no restorable files',
      'notice.failed': 'Rewind failed',
      'notice.unavailable': 'This DSH version does not support that',
      'notice.noSession': 'The session service is unavailable, so the conversation cannot be branched',
      'notice.forkUnavailable': 'This Turn has no committed end yet, so it cannot be branched',
      'header.label': 'Rewind',
      'header.title': 'Rewind to any finished Turn',
      'list.title': 'Choose the Turn to rewind to',
      'list.hint': 'Newest first. ↑↓ to move, Enter to choose, Esc to close.',
      'list.loading': 'Reading the finished Turns…',
      'list.empty': 'No finished Turn to rewind to yet',
      'list.round': 'Turn {n}',
      'list.files': '{count} file(s)',
      'mode.title': 'Turn {n}',
      'mode.chatOnly': 'Rewind the conversation',
      'mode.both': 'Rewind and restore {count} file(s)',
      'mode.back': 'Back to the list',
      'mode.note': 'The rewind creates a new session that ends at this Turn; the original is left untouched.',
    };
    //#endregion

    //#region stylesheet
    const SHEET = [
      '.dshSessionRewind{position:relative;display:inline-flex;align-items:center;gap:6px;vertical-align:middle}',
      '.dshSessionRewindTrigger{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;',
      'border:0;border-radius:999px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);',
      'font-family:var(--dsw-font-family);font-size:11px;line-height:16px}',
      '.dshSessionRewindTrigger:hover:not(:disabled),.dshSessionRewindTrigger[aria-expanded="true"]{',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshSessionRewindTrigger:disabled{opacity:.55;cursor:default}',
      '.dshSessionRewindGlyph{display:inline-flex;align-items:center;justify-content:center;flex:none}',
      '.dshSessionRewindNotice{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshSessionRewindNoticeError{color:var(--dsw-alias-label-error,#b42318)}',
      '.dshSessionRewindPanel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:40;display:flex;',
      'flex-direction:column;gap:8px;width:340px;max-height:min(60vh,420px);overflow:auto;padding:11px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);',
      'box-shadow:0 16px 40px rgba(0,0,0,.22);text-align:left}',
      '.dshSessionRewindTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family)}',
      '.dshSessionRewindHint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);',
      'font-family:var(--dsw-font-family)}',
      '.dshSessionRewindFiles{display:flex;flex-direction:column;gap:4px;padding-top:2px;',
      'border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dshSessionRewindFilesTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);',
      'font-family:var(--dsw-font-family)}',
      '.dshSessionRewindList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}',
      '.dshSessionRewindRow{display:flex;align-items:center;gap:6px;padding:2px 0;min-width:0}',
      '.dshSessionRewindCheck{flex:none;width:12px;height:12px;margin:0;accent-color:var(--dsw-alias-label-primary)}',
      '.dshSessionRewindStub{flex:none;width:12px;height:12px}',
      '.dshSessionRewindPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
      '.dshSessionRewindActionLabel{flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);',
      'font-family:var(--dsw-font-family)}',
      '.dshSessionRewindActions{display:flex;align-items:center;justify-content:flex-end;gap:6px;',
      'padding-top:2px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dshSessionRewindButton{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;',
      'background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'font-family:var(--dsw-font-family);font-size:11px;line-height:16px}',
      '.dshSessionRewindButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshSessionRewindButton:disabled{opacity:.55;cursor:default}',
      '.dshSessionRewindPrimary{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);',
      'color:var(--dsw-alias-bg-base,#fff)}',
      '.dshSessionRewindPrimary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-label-primary)}',
      '.dshSessionRewindError{font-size:11px;line-height:17px;color:var(--dsw-alias-label-error,#b42318);',
      'font-family:var(--dsw-font-family)}',
      // Session-header entry
      '.dshSessionRewindHeader{position:relative;display:inline-flex;align-items:center}',
      '.dshSessionRewindHeaderBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
      'padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshSessionRewindHeaderBtn:hover:not(:disabled),.dshSessionRewindHeaderBtn[aria-expanded="true"]{',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshSessionRewindHeaderBtn:disabled{opacity:.55;cursor:default}',
      '.dshSessionRewindMenu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:flex;',
      'flex-direction:column;gap:6px;width:380px;max-height:min(64vh,460px);overflow:auto;padding:10px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);',
      'box-shadow:0 16px 40px rgba(0,0,0,.22);text-align:left}',
      '.dshSessionRewindRounds{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none}',
      '.dshSessionRewindRound{display:flex;align-items:baseline;gap:8px;padding:5px 7px;border:0;border-radius:7px;',
      'background:transparent;cursor:pointer;text-align:left;width:100%;',
      'font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}',
      '.dshSessionRewindRound:hover,.dshSessionRewindRound[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshSessionRewindRound:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:-2px}',
      '.dshSessionRewindRoundTurn{flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      '.dshSessionRewindRoundText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font-size:12px;line-height:17px}',
      '.dshSessionRewindRoundFiles{flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      '.dshSessionRewindModeText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family);word-break:break-word;max-height:96px;overflow:auto}',
    ].join('\n');
    //#endregion

    function installStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null && existing.textContent === SHEET) return;
      const tag = existing ?? document.createElement('style');
      if (existing !== null) {
        // A revisioned reload must replace the previous text, not duplicate it.
        tag.textContent = SHEET;
        return;
      }
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = SHEET;
      (document.head ?? document.documentElement)?.appendChild(tag);
    }

    function fill(template, params) {
      const text = String(template);
      if (params === null || params === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, (match, name) => {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      });
    }

    const prefersChinese = typeof navigator !== 'undefined'
      && typeof navigator.language === 'string'
      && navigator.language.toLowerCase().startsWith('zh');
    const fallbackDict = prefersChinese ? zh : en;

    function localMessage(key, params) {
      const template = fallbackDict[key] ?? en[key] ?? key;
      return fill(template, params);
    }

    /** The Turn's committed `turn/end` seq, when the Turn object exposes it. */
    function endSeqOf(turn) {
      if (turn === null || typeof turn !== 'object') return undefined;
      const end = turn.end;
      if (end !== null && typeof end === 'object' && typeof end.seq === 'number') return end.seq;
      return undefined;
    }

    /** The Turn's own number, whichever field the Chat timeline exposes it on. */
    function turnNumberOf(turn) {
      if (typeof turn === 'number' && Number.isInteger(turn)) return turn;
      if (turn === null || typeof turn !== 'object') return undefined;
      for (const key of ['turn', 'number', 'index']) {
        const value = turn[key];
        if (typeof value === 'number' && Number.isInteger(value)) return value;
      }
      return undefined;
    }

    function RewindGlyph() {
      return jsx('svg', {
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        'aria-hidden': 'true',
        focusable: 'false',
        children: jsx('path', {
          d: 'M7.2 3.4 2.4 8l4.8 4.6zM13.6 3.4 8.8 8l4.8 4.6z',
          fill: 'currentColor',
        }),
      });
    }

    /**
     * Pre-seed a freshly forked session's composer draft.
     *
     * The Conversation store persists one key per session and reads it while the
     * session's shell is being created, which happens during
     * `uiWorkspace.openSession`; writing the key before that call is what makes
     * the original prompt show up in the composer, ready to edit.
     */
    function seedDraft(sessionId, text) {
      if (typeof text !== 'string' || text === '') return;
      try {
        if (typeof localStorage === 'undefined') return;
        const key = `${DRAFT_STORE_KEY}.${sessionId}`;
        let stored = { draft: null, view: null, viewRequest: null };
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
          } catch {
            /* an unreadable old value is simply replaced */
          }
        }
        stored.draft = { text, references: [] };
        localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        /* a pre-filled draft is a convenience, never a requirement */
      }
    }

    /**
     * The rewind control for one finished Turn.
     * @param {object} props Slot props: `sessionId`, `turn`, `seq`, `tr`, `useAccess`.
     */
    function TurnRewind(props) {
      const tr = typeof props.tr === 'function' ? props.tr : (key, params) => localMessage(key, params);
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined;
      const turnNumber = turnNumberOf(props.turn);
      const endSeq = endSeqOf(props.turn);
      const fallbackSeq = typeof props.seq === 'number' && Number.isInteger(props.seq) ? props.seq : undefined;
      const target = endSeq ?? fallbackSeq;
      const canFork = typeof props.useAccess === 'function' ? props.useAccess('session/fork') !== false : true;

      const [open, setOpen] = React.useState(false);
      const [planning, setPlanning] = React.useState(false);
      const [plan, setPlan] = React.useState(null);
      const [planError, setPlanError] = React.useState(null);
      const [excluded, setExcluded] = React.useState([]);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const wrapRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      React.useEffect(() => () => {
        mountedRef.current = false;
      }, []);

      React.useEffect(() => {
        setPlan(null);
        setPlanError(null);
        setExcluded([]);
        setNotice(null);
        setOpen(false);
      }, [sessionId, target]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = wrapRef.current;
          if (root === null || root === undefined) return;
          if (typeof event?.target === 'object' && root.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event?.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = window.setTimeout(() => {
          if (mountedRef.current) setNotice(null);
        }, NOTICE_MS);
        return () => window.clearTimeout(timer);
      }, [notice]);

      const serviceOf = (serviceName) => {
        try {
          const value = props?.[serviceName];
          if (value !== undefined && value !== null) return value;
        } catch {
          /* fall through to the context */
        }
        try {
          const fromContext = props?.ctx?.get?.(serviceName);
          if (fromContext !== undefined && fromContext !== null) return fromContext;
        } catch {
          /* treat as unavailable */
        }
        return undefined;
      };

      const messageOf = (error) => {
        if (error !== null && typeof error === 'object' && error.status === 503) return tr('notice.unavailable');
        const message = error instanceof Error ? error.message : '';
        return typeof message === 'string' && message !== '' ? message : tr('notice.failed');
      };

      const postJson = async (route, body) => {
        const response = await fetch(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const suffix = detail === '' ? '' : ` ${detail.slice(0, 160)}`;
          const error = new Error(response.status === 503
            ? tr('notice.unavailable')
            : `${tr('notice.failed')}（HTTP ${response.status}${suffix}）`);
          error.status = response.status;
          throw error;
        }
        const value = await response.json();
        if (value === null || typeof value !== 'object') throw new Error(tr('notice.failed'));
        return value;
      };

      const targetOf = () => {
        if (sessionId === undefined) throw new Error(tr('notice.noSession'));
        const payload = { sessionId };
        if (turnNumber !== undefined) payload.turn = turnNumber;
        else if (fallbackSeq !== undefined) payload.seq = fallbackSeq;
        else throw new Error(tr('notice.forkUnavailable'));
        return payload;
      };

      const loadPlan = async () => {
        if (planning) return;
        setPlanning(true);
        setPlanError(null);
        try {
          const value = await postJson(PLAN_ROUTE, targetOf());
          if (!mountedRef.current) return;
          setPlan(value);
          setExcluded([]);
        } catch (error) {
          if (!mountedRef.current) return;
          setPlan(null);
          setPlanError(messageOf(error));
        } finally {
          if (mountedRef.current) setPlanning(false);
        }
      };

      const restoreFiles = async (files) => {
        const payload = targetOf();
        payload.paths = files.map((file) => file.path);
        const value = await postJson(RESTORE_ROUTE, payload);
        const results = Array.isArray(value?.results) ? value.results : [];
        const ok = results.filter((result) => result.status === 'restored' || result.status === 'deleted').length;
        return { ok, failed: results.length - ok };
      };

      const forkConversation = async () => {
        const sessions = serviceOf('sessions');
        if (sessions === undefined || typeof sessions.fork !== 'function') {
          throw new Error(tr('notice.noSession'));
        }
        const boundary = Number.isInteger(plan?.seq) ? plan.seq : target;
        if (!Number.isInteger(boundary)) throw new Error(tr('notice.forkUnavailable'));
        const childId = await sessions.fork({ sessionId, atSeq: boundary, increaseTitle: true });
        if (typeof childId !== 'string' || childId === '') throw new Error(tr('notice.failed'));
        seedDraft(childId, typeof plan?.prompt === 'string' ? plan.prompt : '');
        const workspace = serviceOf('uiWorkspace');
        if (workspace !== undefined && typeof workspace.openSession === 'function') {
          workspace.openSession(childId);
        }
        return childId;
      };

      const files = Array.isArray(plan?.files) ? plan.files : [];
      const restorable = files.filter((file) => file.action === 'restore' || file.action === 'delete');
      const selected = restorable.filter((file) => !excluded.includes(file.path));

      const toggle = (path) => {
        setExcluded((previous) => (previous.includes(path)
          ? previous.filter((entry) => entry !== path)
          : [...previous, path]));
      };

      const runFork = async () => {
        if (busy) return;
        setBusy(true);
        setNotice(null);
        try {
          if (selected.length > 0) await restoreFiles(selected);
          await forkConversation();
        } catch (error) {
          if (mountedRef.current) setNotice({ kind: 'error', text: messageOf(error) });
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };

      const runRestoreOnly = async () => {
        if (busy) return;
        if (selected.length === 0) {
          setNotice({ kind: 'error', text: tr('notice.noFiles') });
          return;
        }
        setBusy(true);
        setNotice(null);
        try {
          const outcome = await restoreFiles(selected);
          if (!mountedRef.current) return;
          setOpen(false);
          setNotice({
            kind: outcome.failed === 0 ? 'ok' : 'error',
            text: outcome.failed === 0
              ? tr('notice.restored', { count: outcome.ok })
              : tr('notice.restoredPartial', { ok: outcome.ok, failed: outcome.failed }),
          });
        } catch (error) {
          if (mountedRef.current) setNotice({ kind: 'error', text: messageOf(error) });
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };

      const onTrigger = () => {
        if (busy) return;
        if (open) {
          setOpen(false);
          return;
        }
        setOpen(true);
        setNotice(null);
        void loadPlan();
      };

      const renderFileRow = (file) => {
        const selectable = file.action === 'restore' || file.action === 'delete';
        return jsxs('li', {
          className: 'dshSessionRewindRow',
          key: file.path,
          children: [
            selectable
              ? jsx('input', {
                type: 'checkbox',
                className: 'dshSessionRewindCheck',
                checked: !excluded.includes(file.path),
                disabled: busy,
                onChange: () => toggle(file.path),
                'aria-label': file.displayPath,
              })
              : jsx('span', { className: 'dshSessionRewindStub', 'aria-hidden': 'true' }),
            jsx('span', {
              className: 'dshSessionRewindPath',
              title: file.path,
              children: file.displayPath,
            }),
            jsx('span', {
              className: 'dshSessionRewindActionLabel',
              children: tr(file.action === 'delete'
                ? 'panel.deleteOne'
                : file.action === 'restore' ? 'panel.restoreOne' : 'panel.skipOne'),
            }),
          ],
        });
      };

      const renderBody = () => {
        if (planning) return jsx('div', { className: 'dshSessionRewindHint', children: tr('panel.planning') });
        if (planError !== null) return jsx('div', { className: 'dshSessionRewindError', children: planError });
        if (files.length === 0) return jsx('div', { className: 'dshSessionRewindHint', children: tr('panel.noFiles') });
        return jsxs('div', {
          className: 'dshSessionRewindFiles',
          children: [
            jsx('div', {
              className: 'dshSessionRewindFilesTitle',
              children: tr('panel.files', { count: files.length }),
            }),
            jsx('ul', { className: 'dshSessionRewindList', children: files.map(renderFileRow) }),
          ],
        });
      };

      const renderPanel = () => jsxs('div', {
        className: 'dshSessionRewindPanel',
        role: 'dialog',
        'aria-label': tr('panel.title'),
        children: [
          jsx('div', { className: 'dshSessionRewindTitle', children: tr('panel.title') }),
          jsx('div', { className: 'dshSessionRewindHint', children: tr('panel.hint') }),
          renderBody(),
          jsxs('div', {
            className: 'dshSessionRewindActions',
            children: [
              canFork
                ? jsx('button', {
                  type: 'button',
                  className: 'dshSessionRewindButton dshSessionRewindPrimary',
                  disabled: busy,
                  onClick: () => {
                    void runFork();
                  },
                  children: tr('action.fork'),
                })
                : null,
              restorable.length > 0
                ? jsx('button', {
                  type: 'button',
                  className: 'dshSessionRewindButton',
                  disabled: busy,
                  onClick: () => {
                    void runRestoreOnly();
                  },
                  children: tr('action.restore'),
                })
                : null,
              jsx('button', {
                type: 'button',
                className: 'dshSessionRewindButton',
                disabled: busy,
                onClick: () => setOpen(false),
                children: tr('action.cancel'),
              }),
            ],
          }),
        ],
      });

      if (sessionId === undefined || target === undefined) return null;

      return jsxs('span', {
        className: 'dshSessionRewind',
        ref: wrapRef,
        children: [
          jsxs('button', {
            type: 'button',
            className: 'dshSessionRewindTrigger',
            title: tr('button.title'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busy,
            onClick: onTrigger,
            children: [
              jsx('span', { className: 'dshSessionRewindGlyph', children: jsx(RewindGlyph, {}) }),
              jsx('span', { children: tr('button.label') }),
            ],
          }),
          notice === null || open
            ? null
            : jsx('span', {
              className: notice.kind === 'error'
                ? 'dshSessionRewindNotice dshSessionRewindNoticeError'
                : 'dshSessionRewindNotice',
              children: notice.text,
            }),
          open ? renderPanel() : null,
        ],
      });
    }

    /** One-line preview of a message body for the candidate list. */
    function previewOf(value) {
      if (typeof value !== 'string') return '—';
      const text = value.replace(/\s+/gu, ' ').trim();
      if (text === '') return '—';
      return text.length > 72 ? `${text.slice(0, 72)}…` : text;
    }

    /**
     * The Chat header entry: every finished Turn of this Session as a rewind
     * target, so a rewind does not require scrolling back to the Turn itself.
     * Keyboard: ↑↓ move, Enter choose, Esc back/close.
     */
    function SessionRewind(props) {
      const tr = typeof props.tr === 'function' ? props.tr : (key, params) => localMessage(key, params);
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined;
      const canFork = typeof props.useAccess === 'function' ? props.useAccess('session/fork') !== false : true;

      const [open, setOpen] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [rounds, setRounds] = React.useState([]);
      const [active, setActive] = React.useState(0);
      const [chosen, setChosen] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const wrapRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      React.useEffect(() => () => {
        mountedRef.current = false;
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = wrapRef.current;
          if (root === null || root === undefined) return;
          if (typeof event?.target === 'object' && root.contains(event.target)) return;
          setOpen(false);
          setChosen(null);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          const key = event?.key;
          if (key === 'Escape') {
            if (chosen !== null) setChosen(null);
            else setOpen(false);
            return;
          }
          if (chosen !== null) return;
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            setActive((previous) => {
              const size = rounds.length;
              if (size === 0) return 0;
              return key === 'ArrowDown' ? (previous + 1) % size : (previous - 1 + size) % size;
            });
            return;
          }
          if (key === 'Enter') {
            const candidate = rounds[active];
            if (candidate !== undefined) setChosen(candidate);
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [open, chosen, rounds, active]);

      const serviceOf = (serviceName) => {
        try {
          const value = props?.ctx?.get?.(serviceName);
          if (value !== undefined && value !== null) return value;
        } catch {
          /* treat as unavailable */
        }
        return undefined;
      };

      const messageOf = (failure) => {
        if (failure !== null && typeof failure === 'object' && failure.status === 503) return tr('notice.unavailable');
        const message = failure instanceof Error ? failure.message : '';
        return typeof message === 'string' && message !== '' ? message : tr('notice.failed');
      };

      const postJson = async (route, body) => {
        const response = await fetch(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const error = new Error(response.status === 503
            ? tr('notice.unavailable')
            : `${tr('notice.failed')}（HTTP ${response.status}）`);
          error.status = response.status;
          throw error;
        }
        const value = await response.json();
        if (value === null || typeof value !== 'object') throw new Error(tr('notice.failed'));
        return value;
      };

      const loadRounds = async () => {
        if (sessionId === undefined) return;
        setLoading(true);
        setError(null);
        try {
          const value = await postJson(CANDIDATES_ROUTE, { sessionId });
          if (!mountedRef.current) return;
          const list = Array.isArray(value.turns)
            ? value.turns.filter((item) => item !== null && typeof item === 'object' && Number.isInteger(item.seq))
            : [];
          setRounds(list);
          setActive(0);
        } catch (failure) {
          if (!mountedRef.current) return;
          setRounds([]);
          setError(messageOf(failure));
        } finally {
          if (mountedRef.current) setLoading(false);
        }
      };

      const execute = async (candidate, withFiles) => {
        if (busy) return;
        const sessions = serviceOf('sessions');
        if (sessions === undefined || typeof sessions.fork !== 'function') {
          setError(tr('notice.noSession'));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          if (withFiles) await postJson(RESTORE_ROUTE, { sessionId, turn: candidate.turn });
          const childId = await sessions.fork({ sessionId, atSeq: candidate.seq, increaseTitle: true });
          if (typeof childId !== 'string' || childId === '') throw new Error(tr('notice.failed'));
          seedDraft(childId, typeof candidate.prompt === 'string' ? candidate.prompt : '');
          const workspace = serviceOf('uiWorkspace');
          if (workspace !== undefined && typeof workspace.openSession === 'function') {
            workspace.openSession(childId);
          }
          if (mountedRef.current) {
            setOpen(false);
            setChosen(null);
          }
        } catch (failure) {
          if (mountedRef.current) setError(messageOf(failure));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };

      if (sessionId === undefined || !canFork) return null;

      const renderRounds = () => {
        if (loading) return jsx('div', { className: 'dshSessionRewindHint', children: tr('list.loading') });
        if (rounds.length === 0) return jsx('div', { className: 'dshSessionRewindHint', children: tr('list.empty') });
        return jsx('ul', {
          className: 'dshSessionRewindRounds',
          children: rounds.map((candidate, index) => jsx('li', {
            key: `${String(candidate.turn)}:${String(candidate.seq)}`,
            children: jsxs('button', {
              type: 'button',
              className: 'dshSessionRewindRound',
              'data-active': index === active ? 'true' : 'false',
              disabled: busy,
              onClick: () => {
                setActive(index);
                setChosen(candidate);
              },
              onMouseEnter: () => setActive(index),
              children: [
                jsx('span', {
                  className: 'dshSessionRewindRoundTurn',
                  children: tr('list.round', { n: candidate.turn }),
                }),
                jsx('span', {
                  className: 'dshSessionRewindRoundText',
                  children: previewOf(candidate.prompt),
                }),
                jsx('span', {
                  className: 'dshSessionRewindRoundFiles',
                  children: tr('list.files', { count: candidate.files?.count ?? 0 }),
                }),
              ],
            }),
          })),
        });
      };

      const renderChosen = () => {
        const count = typeof chosen.files?.count === 'number' ? chosen.files.count : 0;
        return [
          jsx('div', {
            className: 'dshSessionRewindTitle',
            key: 'title',
            children: tr('mode.title', { n: chosen.turn }),
          }),
          jsx('p', {
            className: 'dshSessionRewindModeText',
            key: 'text',
            children: previewOf(chosen.prompt),
          }),
          jsx('div', {
            className: 'dshSessionRewindHint',
            key: 'note',
            children: tr('mode.note'),
          }),
          jsxs('div', {
            className: 'dshSessionRewindActions',
            key: 'actions',
            children: [
              jsx('button', {
                type: 'button',
                className: 'dshSessionRewindButton dshSessionRewindPrimary',
                disabled: busy,
                onClick: () => {
                  void execute(chosen, false);
                },
                children: tr('mode.chatOnly'),
              }),
              count > 0
                ? jsx('button', {
                  type: 'button',
                  className: 'dshSessionRewindButton',
                  disabled: busy,
                  onClick: () => {
                    void execute(chosen, true);
                  },
                  children: tr('mode.both', { count }),
                })
                : null,
              jsx('button', {
                type: 'button',
                className: 'dshSessionRewindButton',
                disabled: busy,
                onClick: () => setChosen(null),
                children: tr('mode.back'),
              }),
            ],
          }),
        ];
      };

      const renderMenu = () => jsxs('div', {
        className: 'dshSessionRewindMenu',
        role: 'dialog',
        'aria-label': chosen === null ? tr('list.title') : tr('mode.title', { n: chosen.turn }),
        children: [
          error === null ? null : jsx('div', { key: 'error', className: 'dshSessionRewindError', children: error }),
          chosen === null
            ? jsx('div', { key: 'title', className: 'dshSessionRewindTitle', children: tr('list.title') })
            : null,
          chosen === null
            ? jsx('div', { key: 'hint', className: 'dshSessionRewindHint', children: tr('list.hint') })
            : null,
          chosen === null ? renderRounds() : renderChosen(),
        ],
      });

      return jsxs('span', {
        className: 'dshSessionRewindHeader',
        ref: wrapRef,
        children: [
          jsx('button', {
            type: 'button',
            className: 'dshSessionRewindHeaderBtn',
            title: tr('header.title'),
            'aria-label': tr('header.title'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busy,
            onClick: () => {
              if (busy) return;
              if (open) {
                setOpen(false);
                setChosen(null);
                return;
              }
              setOpen(true);
              setError(null);
              void loadRounds();
            },
            children: jsx(RewindGlyph, {}),
          }),
          open ? renderMenu() : null,
        ],
      });
    }

    /**
     * @param {object} ctx DSH Cordis client context.
     */
    function apply(ctx) {
      if (jsx === null || jsxs === null || React === null) return;
      if (typeof React.useState !== 'function'
        || typeof React.useRef !== 'function'
        || typeof React.useEffect !== 'function') return;

      try {
        installStyle();
      } catch {
        /* a missing <head> only costs styling */
      }

      let boundTranslate = null;
      const tr = (key, params) => {
        if (boundTranslate !== null) {
          try {
            return boundTranslate(key, params);
          } catch {
            /* fall back to the bundled dictionaries */
          }
        }
        return localMessage(key, params);
      };

      try {
        ctx.inject(['locale'], (scope) => {
          try {
            scope.effect(() => scope.locale.register(NS, { zh, en }), 'session-rewind: dictionaries');
            const bound = scope.locale.bind(NS);
            if (typeof bound === 'function') boundTranslate = bound;
          } catch {
            /* bundled dictionaries remain in charge */
          }
        });
      } catch {
        /* the locale service is optional */
      }

      // `ctx` is handed to the components so they can reach `sessions` /
      // `uiWorkspace` lazily: resolving them at registration time would pin a
      // service instance that a plugin reload has already replaced.
      const component = (props) => jsx(TurnRewind, { ...props, ctx, tr });
      const headerComponent = (props) => jsx(SessionRewind, { ...props, ctx, tr });

      try {
        ctx.inject(['slots'], (scope) => {
          try {
            scope.slots.inject(SLOT_NAME, () => scope.slots.register({
              name: SLOT_NAME,
              id: PLUGIN_ID,
              order: -1,
              inject: () => ({ tr }),
            }, component));
          } catch (error) {
            warn(error);
          }
          try {
            scope.slots.inject(HEADER_SLOT, () => scope.slots.register({
              name: HEADER_SLOT,
              id: PLUGIN_ID,
              order: -1,
              inject: () => ({ tr }),
            }, headerComponent));
          } catch (error) {
            warn(error);
          }
        });
      } catch (error) {
        warn(error);
      }
    }

    function warn(error) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[dsh-session-rewind]', error);
      } catch {
        /* nothing else to do */
      }
    }

    exports.apply = apply;
    /** The Chat turn-tail slot is the only service this plugin needs. */
    exports.inject = [];
    return module.exports;
  },
});
})();
