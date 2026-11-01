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
    const INPLACE_ROUTE = '/api/session-rewind.inplace';
    const CUTS_ROUTE = '/api/session-rewind.cuts';
    const DIAGNOSE_ROUTE = '/api/session-rewind.diagnose';
    const TAIL_ROUTE = '/api/session-rewind.tail';
    const BOOT_REVISION = '1.3.2';
    const HIDDEN_ATTR = 'data-session-rewind-hidden';

    /** One per-message bridge per session, shared by every TurnRewind instance. */
    const bridgeRegistry = new Map();
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
      'mode.inplace': '就地回退',
      'mode.inplaceFiles': '回退并恢复 {count} 个文件',
      'mode.fork': '在新会话中分支',
      'mode.inplaceNote': '就地回退会撤回这条消息及之后的内容，原话回到输入框，可以改完重发；日志只追加，不会删改。',
      'message.title': '回退到这条消息',
      'popover.chat': '仅回退对话',
      'popover.both': '回退对话并恢复文件',
      'notice.working': '正在回退…',
      'notice.rewound': '已回退',
      'notice.refilled': '原话已放回输入框',
      'notice.failed': '回退失败',
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
      'mode.inplace': 'Rewind in place',
      'mode.inplaceFiles': 'Rewind and restore {count} file(s)',
      'mode.fork': 'Branch into a new session',
      'mode.inplaceNote': 'An in-place rewind withdraws this message and everything after it, puts the text back in the composer so you can edit and resend, and leaves the log intact.',
      'message.title': 'Rewind to this message',
      'popover.chat': 'Rewind the conversation',
      'popover.both': 'Rewind and restore files',
      'notice.working': 'Rewinding…',
      'notice.rewound': 'Rewound',
      'notice.refilled': 'Original text is back in the composer',
      'notice.failed': 'Rewind failed',
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
    '[data-session-rewind-hidden="true"]{display:none !important}',
    ].join('\n');
    //#endregion

    /** Send one structural report to the Host. Never throws, never blocks. */
    function sendDiagnose(sessionId, payload) {
      try {
        void fetch(DIAGNOSE_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, report: payload }),
          credentials: 'same-origin',
        }).catch(() => undefined);
      } catch {
        /* diagnostics must never break the page */
      }
    }

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

      // The per-message bridge lives here because this control is rendered for
      // every finished Turn, so it is guaranteed to mount: one ↶ per user
      // message, the row hiding an executed in-place rewind needs, and the
      // composer refill. Re-created when the session changes, reversed on
      // unmount.
      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const existing = bridgeRegistry.get(sessionId);
        if (existing !== undefined) {
          existing.refs += 1;
          return () => {
            existing.refs -= 1;
            if (existing.refs > 0) return;
            bridgeRegistry.delete(sessionId);
            try {
              existing.bridge.dispose();
            } catch (error) {
              warn(error);
            }
          };
        }
        let bridge;
        try {
          bridge = createRowBridge({
            ctx: props?.ctx,
            sessionId,
            tr,
            inputActions: props?.inputActions,
          });
        } catch (error) {
          sendDiagnose('__boot__', {
            reason: 'bridge-failed',
            error: String(error && error.message ? error.message : error),
            boot: BOOT_REVISION,
          });
          warn(error);
          return undefined;
        }
        const entry = { refs: 1, bridge };
        bridgeRegistry.set(sessionId, entry);
        sendDiagnose('__boot__', { reason: 'bridge-mounted', sessionId, boot: BOOT_REVISION });
        return () => {
          entry.refs -= 1;
          if (entry.refs > 0) return;
          bridgeRegistry.delete(sessionId);
          try {
            bridge.dispose();
          } catch (error) {
            warn(error);
          }
        };
      }, [sessionId]);

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
     * The per-message rewind bridge.
     *
     * DSH has no slot for an action row inside a user message, so this adds one
     * small control per rendered user row at the DOM level — the same seam the
     * reference `dsh-rewind` uses. Everything is feature-detected and reversed on
     * dispose: rows it hides are restored, buttons it adds are removed, and the
     * observer is disconnected. It never makes a DOM change on its own; the user
     * must click a button.
     */
    function createRowBridge({ ctx, sessionId, tr, inputActions }) {
      const state = {
        disposed: false,
        turnToSeq: new Map(),
        hiddenTurns: new Set(),
        buttons: new Map(),
        hiddenRows: new Map(),
        observer: null,
        scheduled: 0,
        popover: null,
      };

      const errors = [];
      const seen = new Set();

      /**
       * Describe one element's structure without any message text, so the page
       * can tell the Host what it actually renders. Used only for diagnostics.
       */
      const describeNode = (element, depth) => {
        if (element === null || element === undefined || depth < 0) return null;
        const attrs = {};
        for (const attribute of Array.from(element.attributes ?? [])) {
          if (!String(attribute.name).startsWith('data-')) continue;
          attrs[attribute.name] = String(attribute.value).slice(0, 80);
        }
        const children = [];
        for (const child of Array.from(element.children ?? []).slice(0, 8)) {
          const described = describeNode(child, depth - 1);
          if (described !== null) children.push(described);
        }
        return {
          tag: String(element.tagName ?? '').toLowerCase(),
          cls: String(element.className ?? '').slice(0, 120),
          attrs,
          ...(children.length === 0 ? {} : { children }),
        };
      };

      /** Send one structural snapshot to the Host (no text, memory only). */
      const report = (reason) => {
        let payload;
        try {
          const userRows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
          const turnRows = Array.from(document.querySelectorAll('[data-chat-turn]'));
          const mappedRows = userRows.filter((row) => {
            const turn = Number(row.getAttribute('data-chat-turn') ?? row.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'));
            return Number.isInteger(turn) && state.turnToSeq.has(turn);
          });
          payload = {
            reason,
            mounted: true,
            url: String(window.location?.pathname ?? ''),
            counts: {
              userRows: userRows.length,
              turnRows: turnRows.length,
              mappedRows: mappedRows.length,
              mapped: state.turnToSeq.size,
              injected: state.buttons.size,
              glyphs: Array.from(state.buttons.values()).filter((b) => b.querySelector('svg') !== null).length,
            },
            sampleUserRow: userRows[0] === undefined ? null : describeNode(userRows[0], 3),
            sampleTurnRow: turnRows[0] === undefined ? null : describeNode(turnRows[0], 2),
            errors: errors.slice(0, 5),
          };
        } catch (error) {
          payload = { reason, mounted: true, fatal: String(error && error.message ? error.message : error) };
        }
        try {
          void fetch(DIAGNOSE_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, report: payload }),
            credentials: 'same-origin',
          }).catch(() => undefined);
        } catch {
          /* diagnostics must never break the page */
        }
      };

      const serviceOf = (name) => {
        try {
          const value = ctx?.get?.(name);
          return value === undefined ? undefined : value;
        } catch {
          return undefined;
        }
      };

      const postJson = async (route, body) => {
        const response = await fetch(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
        const value = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(
            (value !== null && typeof value === 'object' && typeof value.message === 'string'
              ? value.message
              : `${tr('notice.failed')}（HTTP ${response.status}）`),
          );
          error.status = response.status;
          error.code = value !== null && typeof value === 'object' && typeof value.code === 'string' ? value.code : null;
          throw error;
        }
        return value;
      };

      /** Put a message body back into this session's composer. */
      const setComposer = (text) => {
        if (typeof text !== 'string' || text === '') return false;
        try {
          if (inputActions !== undefined && inputActions !== null && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(text);
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
            return true;
          }
        } catch {
          /* fall through to the facade */
        }
        try {
          const conversation = serviceOf('conversation');
          const sessions = serviceOf('sessions');
          const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
          const input = conversation?.input;
          if (input !== undefined && scope !== undefined) {
            input.for(scope).setDraft(text);
            if (typeof input.for(scope).focus === 'function') input.for(scope).focus();
            return true;
          }
        } catch {
          /* fall through to the raw element */
        }
        try {
          const element = document.querySelector('[data-composer-input]');
          if (element === null) return false;
          element.textContent = text;
          return true;
        } catch {
          return false;
        }
      };

      /** Hide or restore the rendered rows at or after the executed cut. */
      /**
       * Hide exactly the rows of the Turns a rewind withdrew.
       *
       * The attribute (plus a `display: none !important` rule in SHEET) is used
       * instead of an inline style because the Chat re-renders its rows and would
       * drop an inline override; an unknown attribute survives that. Turns the user
       * starts after rewinding are not in the set, so they stay visible.
       */
      const applyHiding = () => {
        if (state.disposed) return;
        const rows = document.querySelectorAll('[data-chat-turn]');
        for (const row of rows) {
          const turn = Number(row.getAttribute('data-chat-turn'));
          if (!Number.isInteger(turn)) continue;
          if (state.hiddenTurns.has(turn)) {
            if (!row.hasAttribute(HIDDEN_ATTR)) row.setAttribute(HIDDEN_ATTR, 'true');
          } else if (row.hasAttribute(HIDDEN_ATTR)) {
            row.removeAttribute(HIDDEN_ATTR);
          }
        }
      };

      const revealAll = () => {
        state.hiddenTurns.clear();
        for (const row of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) row.removeAttribute(HIDDEN_ATTR);
      };

      const closePopover = () => {
        if (state.popover !== null) {
          try {
            state.popover.remove();
          } catch {
            /* already gone */
          }
          state.popover = null;
        }
      };

      const runRewind = async (seq, restoreFiles, notice, fromTurn = null) => {
        try {
          notice(tr('notice.working'));
          const result = await postJson(INPLACE_ROUTE, { sessionId, seq, restoreFiles });
          if (state.disposed) return;
          if (Array.isArray(result.hiddenTurns) && result.hiddenTurns.length > 0) {
            for (const turn of result.hiddenTurns) {
              if (Number.isInteger(turn)) state.hiddenTurns.add(turn);
            }
          } else if (Number.isInteger(result.hiddenFromTurn)) {
            state.hiddenTurns = new Set([result.hiddenFromTurn]);
          }
          applyHiding();
          const filled = setComposer(typeof result.prompt === 'string' ? result.prompt : '');
          sendDiagnose(sessionId, {
            reason: 'rewind',
            filled,
            markerSeq: result.markerSeq,
            hiddenFromTurn: result.hiddenFromTurn,
            promptChars: typeof result.prompt === 'string' ? result.prompt.length : 0,
            restore: result.restore ?? null,
            injected: state.buttons.size,
            hiddenRows: state.hiddenTurns.size,
          });
          const restore = result.restore;
          const parts = [];
          if (filled) parts.push(tr('notice.refilled'));
          if (restore !== undefined && (restore.restored > 0 || restore.deleted > 0)) {
            parts.push(tr('notice.restored', { count: restore.restored + restore.deleted }));
          }
          notice(parts.length === 0 ? tr('notice.rewound') : `${tr('notice.rewound')} · ${parts.join(' · ')}`);
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? error.code ?? null : null;
          sendDiagnose(sessionId, {
            reason: 'rewind-failed',
            error: String(error && error.message ? error.message : error),
            code,
            sequence: seq,
          });
          if (code === 'not-on-surface') {
            // Already withdrawn by an earlier rewind: hide the row and say so,
            // instead of reporting a failure the user cannot act on.
            const turn = Number.isInteger(fromTurn) ? fromTurn : null;
            if (Number.isInteger(turn)) {
              state.hiddenTurns.add(turn);
              applyHiding();
            }
            notice(tr('notice.already'));
            return;
          }
          notice(error instanceof Error && error.message !== '' ? error.message : tr('notice.failed'));
        }
      };

      const openPopover = (anchor, seq, notice, turn = null) => {
        closePopover();
        const popover = document.createElement('div');
        popover.setAttribute('data-session-rewind-popover', '');
        popover.style.cssText = [
          'position:fixed',
          'z-index:60',
          'display:flex',
          'flex-direction:column',
          'gap:4px',
          'min-width:196px',
          'padding:6px',
          'border:1px solid var(--dsw-alias-border-l2)',
          'border-radius:10px',
          'background:var(--dsw-alias-bg-base,#fff)',
          'box-shadow:0 12px 28px rgba(0,0,0,.18)',
        ].join(';');
        const rect = typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
        if (rect !== null) {
          popover.style.left = `${String(Math.max(8, Math.round(rect.left) - 120))}px`;
          popover.style.top = `${String(Math.round(rect.bottom) + 6)}px`;
        }
        const makeButton = (label, onClick) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.style.cssText = [
            'padding:4px 9px',
            'border:0',
            'border-radius:7px',
            'background:transparent',
            'cursor:pointer',
            'text-align:left',
            'font-family:var(--dsw-font-family)',
            'font-size:12px',
            'color:var(--dsw-alias-label-primary)',
          ].join(';');
          button.addEventListener('mouseenter', () => {
            button.style.background = 'var(--dsw-alias-interactive-bg-hover)';
          });
          button.addEventListener('mouseleave', () => {
            button.style.background = 'transparent';
          });
          button.addEventListener('click', () => {
            try {
              onClick();
            } catch (error) {
              sendDiagnose(sessionId, {
                reason: 'option-failed',
                error: String(error && error.message ? error.message : error),
                boot: BOOT_REVISION,
                sequence: seq,
              });
            }
          });
          return button;
        };
        popover.appendChild(makeButton(tr('popover.chat'), () => {
          closePopover();
          void runRewind(seq, false, notice, turn);
        }));
        popover.appendChild(makeButton(tr('popover.both'), () => {
          closePopover();
          void runRewind(seq, true, notice, turn);
        }));
        document.body.appendChild(popover);
        state.popover = popover;
        const onOutside = (event) => {
          if (state.popover === null) return;
          if (typeof event?.target === 'object' && state.popover.contains(event.target)) return;
          closePopover();
          document.removeEventListener('pointerdown', onOutside, true);
        };
        const onKey = (event) => {
          if (event?.key !== 'Escape') return;
          closePopover();
          document.removeEventListener('keydown', onKey);
        };
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey);
      };

      const notice = (text) => {
        try {
          if (typeof inputActions?.persistDraft === 'function') return;
        } catch {
          /* ignore */
        }
        // A transient status line pinned to the chat, so a failure is visible.
        let tag = document.querySelector('[data-session-rewind-notice]');
        if (tag === null) {
          tag = document.createElement('div');
          tag.setAttribute('data-session-rewind-notice', '');
          tag.style.cssText = [
            'position:fixed',
            'left:50%',
            'bottom:96px',
            'transform:translateX(-50%)',
            'z-index:70',
            'padding:4px 10px',
            'border-radius:999px',
            'background:var(--dsw-alias-bg-base,#fff)',
            'border:1px solid var(--dsw-alias-border-l2)',
            'color:var(--dsw-alias-label-primary)',
            'font-family:var(--dsw-font-family)',
            'font-size:11px',
            'box-shadow:0 8px 20px rgba(0,0,0,.16)',
          ].join(';');
          document.body.appendChild(tag);
        }
        tag.textContent = text;
        window.clearTimeout(notice.timer);
        notice.timer = window.setTimeout(() => {
          try {
            tag.remove();
          } catch {
            /* already gone */
          }
        }, 4200);
      };

      const turnOfRow = (row) => {
        const own = Number(row.getAttribute('data-chat-turn'));
        if (Number.isInteger(own)) return own;
        const holder = typeof row.closest === 'function' ? row.closest('[data-chat-turn]') : null;
        const inherited = Number(holder?.getAttribute('data-chat-turn'));
        return Number.isInteger(inherited) ? inherited : undefined;
      };

      const inject = () => {
        if (state.disposed) return;
        const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
        for (const row of rows) {
          const turn = turnOfRow(row);
          if (!Number.isInteger(turn)) continue;
          const seq = state.turnToSeq.get(turn);
          if (seq === undefined || seq === null) continue;
          if (row.querySelector('[data-session-rewind-btn]') !== null) continue;
          const buttons = Array.from(row.querySelectorAll('button')).filter(
            (button) => !button.hasAttribute('data-session-rewind-btn'),
          );
          let anchor = buttons.length > 0 ? buttons[buttons.length - 1].parentElement : null;
          if (anchor === null || anchor === undefined) {
            // A plain hover-less user bubble carries no buttons: host the control
            // in its own container at the end of the row.
            anchor = document.createElement('span');
            anchor.setAttribute('data-session-rewind-host', '');
            anchor.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle';
            row.appendChild(anchor);
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-session-rewind-btn', '');
          button.title = tr('message.title');
          button.setAttribute('aria-label', tr('message.title'));
          // Same 16x16 / stroke-2 undo glyph the app's own icon set uses, and
          // `color: inherit` so it takes the action row's own colour instead of
          // inventing one.
          button.innerHTML = [
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"',
            ' stroke="currentColor" stroke-width="2" stroke-linecap="round"',
            ' stroke-linejoin="round" aria-hidden="true" focusable="false">',
            '<path d="M9 14 4 9l5-5" />',
            '<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v.5" />',
            '</svg>',
          ].join('');
          button.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'flex:none',
            'width:20px',
            'height:20px',
            'padding:0',
            'border:0',
            'border-radius:4px',
            'background:transparent',
            'cursor:pointer',
            'color:inherit',
            'line-height:0',
            'vertical-align:middle',
          ].join(';');
          button.addEventListener('mouseenter', () => {
            button.style.background = 'var(--dsw-alias-interactive-bg-hover)';
          });
          button.addEventListener('mouseleave', () => {
            button.style.background = 'transparent';
          });
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            sendDiagnose(sessionId, { reason: 'click', turn, seq, buttons: state.buttons.size, mapped: state.turnToSeq.size });
            openPopover(button, seq, notice, turn);
          });
          anchor.appendChild(button);
          state.buttons.set(row, button);
        }
      };

      let reporting = false;
      const schedule = () => {
        if (state.disposed || state.scheduled !== 0) return;
        state.scheduled = window.setTimeout(() => {
          state.scheduled = 0;
          let injected = state.buttons.size;
          try {
            inject();
            applyHiding();
          } catch (error) {
            errors.push(String(error && error.message ? error.message : error));
          }
          // A message sent after the last fetch has no target yet: re-read the
          // candidate map (throttled) so the newest row gets a control too.
          try {
            const unmapped = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).some(
              (row) => row.querySelector('[data-session-rewind-btn]') === null,
            );
            if (unmapped && Date.now() - candidatesAt > 1500) void loadCandidates();
          } catch {
            /* ignore */
          }
          // Report once when the page has rows but nothing could be attached, so
          // the Host can see why without a browser inspector.
          if (!reporting && state.buttons.size > 0) {
            reporting = true;
            report('attached');
          } else if (!reporting && state.buttons.size === 0 && injected === 0) {
            const marker = `${String(document.querySelectorAll('[data-chat-flow-kind="user"]').length)}:${String(state.turnToSeq.size)}`;
            if (!seen.has(marker)) {
              seen.add(marker);
              report('no-attach');
            }
          }
        }, 120);
      };

      let candidatesAt = 0;
      const loadCandidates = async () => {
        candidatesAt = Date.now();
        try {
          const value = await postJson(CANDIDATES_ROUTE, { sessionId });
          if (state.disposed) return;
          const next = new Map();
          for (const candidate of Array.isArray(value.turns) ? value.turns : []) {
            if (Number.isInteger(candidate?.turn) && Number.isInteger(candidate?.userSeq)) {
              next.set(candidate.turn, candidate.userSeq);
            }
          }
          state.turnToSeq = next;
          schedule();
        } catch {
          /* the bridge simply stays empty */
        }
      };

      const loadCuts = async () => {
        try {
          const value = await postJson(CUTS_ROUTE, { sessionId });
          if (state.disposed) return;
          if (Array.isArray(value.hiddenTurns)) {
            state.hiddenTurns = new Set(value.hiddenTurns.filter((turn) => Number.isInteger(turn)));
          } else if (Number.isInteger(value.hiddenFromTurn)) {
            state.hiddenTurns = new Set([value.hiddenFromTurn]);
          }
          applyHiding();
        } catch {
          /* ignore */
        }
      };

      try {
        state.observer = new window.MutationObserver(() => {
          schedule();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
      } catch {
        state.observer = null;
      }
      void loadCandidates();
      void loadCuts();
      schedule();
      window.setTimeout(() => {
        if (!state.disposed) report('mount');
      }, 2600);

      return {
        /** Re-read the cut and the candidate map after an external rewind. */
        refresh() {
          void loadCandidates();
          void loadCuts();
        },
        /** Run one in-place rewind from any UI that already knows the seq. */
        rewind(seq, restoreFiles) {
          return runRewind(seq, restoreFiles === true, notice);
        },
        dispose() {
          state.disposed = true;
          closePopover();
          try {
            state.observer?.disconnect();
          } catch {
            /* ignore */
          }
          window.clearTimeout(state.scheduled);
          for (const button of state.buttons.values()) {
            try {
              button.remove();
            } catch {
              /* ignore */
            }
          }
          state.buttons.clear();
          for (const [row, display] of state.hiddenRows) {
            try {
              row.style.display = display;
            } catch {
              /* ignore */
            }
          }
          state.hiddenRows.clear();
          try {
            document.querySelector('[data-session-rewind-notice]')?.remove();
          } catch {
            /* ignore */
          }
        },
      };
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

      const executeInPlace = async (candidate, withFiles) => {
        // The bridge is owned by the turn-tail component; here we only borrow it.
        const bridge = bridgeRegistry.get(sessionId)?.bridge ?? null;
        const target = Number.isInteger(candidate?.userSeq) ? candidate.userSeq : null;
        if (target === null) {
          setError(tr('notice.forkUnavailable'));
          return;
        }
        if (bridge === null) {
          setError(tr('notice.unavailable'));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await bridge.rewind(target, withFiles);
          if (mountedRef.current) {
            setOpen(false);
            setChosen(null);
          }
        } finally {
          if (mountedRef.current) setBusy(false);
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
          jsx('div', {
            className: 'dshSessionRewindHint',
            key: 'inplaceNote',
            children: tr('mode.inplaceNote'),
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
                  void executeInPlace(chosen, false);
                },
                children: tr('mode.inplace'),
              }),
              count > 0
                ? jsx('button', {
                  type: 'button',
                  className: 'dshSessionRewindButton',
                  disabled: busy,
                  onClick: () => {
                    void executeInPlace(chosen, true);
                  },
                  children: tr('mode.inplaceFiles', { count }),
                })
                : null,
              jsx('button', {
                type: 'button',
                className: 'dshSessionRewindButton',
                disabled: busy,
                onClick: () => {
                  void execute(chosen, false);
                },
                children: tr('mode.fork'),
              }),
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
          const injected = [];
          try {
            scope.slots.inject(SLOT_NAME, () => scope.slots.register({
              name: SLOT_NAME,
              id: PLUGIN_ID,
              order: -1,
              inject: () => ({ tr }),
            }, component));
            injected.push(SLOT_NAME);
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
            injected.push(HEADER_SLOT);
          } catch (error) {
            warn(error);
          }
          sendDiagnose('__boot__', {
            reason: 'apply',
            slots: injected,
            boot: BOOT_REVISION,
            hasDocument: typeof document !== 'undefined',
          });
        });
      } catch (error) {
        warn(error);
        sendDiagnose('__boot__', { reason: 'apply-failed', error: String(error && error.message ? error.message : error), boot: BOOT_REVISION });
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
