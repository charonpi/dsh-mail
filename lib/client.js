/**
 * dsh-mail 的浏览器端：左侧栏一个独立入口 + 主区一个独立页面。
 *
 * 这是 DSH 的**正式客户端插件**形式，不是往页面里塞脚本。契约（由宿主外壳提供）：
 *   - 本文件由 Web 外壳以模块加载器脚本的形式求值：`window.__ModuleLoader__.load({id, factory})`。
 *   - `factory(require)` 里的 `require` 只有三个种子词：`react`、`react/jsx-runtime`、
 *     `@deepseek-ai/dsh-client-ui-primitives`。所以这里**不用 JSX**（没有编译步骤），
 *     一律 `react.createElement`。
 *   - 导出 `apply(ctx)` 与 `inject`，由宿主当作普通插件挂载。
 *
 * 两个槽位：
 *   `sidebar.panellist` —— 左侧栏一行（图标 + 标题 + 顺序）
 *   `main`              —— 该行的主区页面，`key` 必须与侧栏行的 `id` 一致
 *
 * 数据全部走宿主自己的 HTTP 接口（相对路径，桌面壳会把它代理到本地服务）：
 *   GET/POST /dsh-mail/api/accounts
 * 因此这里不需要 `remote`/typert 那套 RPC 生成物。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mail',
  factory: (require) => {
    const module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    /** 侧栏行的 id，同时也是主区页面的 key —— 两者必须一致。 */
    const PANEL_ID = 'dsh-mail.accounts';
    const API = '/dsh-mail/api/accounts';

    const CSS = `
.dm-page{box-sizing:border-box;display:flex;flex-direction:column;gap:18px;padding:26px 30px;max-width:820px;
  font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1f2328}
.dm-h1{margin:0;font-size:20px;font-weight:650}
.dm-sub{margin:2px 0 0;font-size:12px;color:#6b7280}
.dm-card{border:1px solid #e6e8eb;border-radius:14px;padding:18px 20px;background:#fff}
.dm-card-title{margin:0 0 12px;font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:#6b7280}
.dm-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #eceef1;border-radius:10px;margin-bottom:8px}
.dm-row:last-child{margin-bottom:0}
.dm-row-main{flex:1;min-width:0}
.dm-row-id{font-weight:600;font-size:13px}
.dm-row-meta{font-size:12px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#f3f4f6;color:#4b5563;white-space:nowrap}
.dm-badge.ok{background:#e7f6ec;color:#177245}
.dm-badge.warn{background:#fdf1e3;color:#9a5b00}
.dm-btn{border:1px solid #d8dbe0;background:#fff;color:#1f2328;border-radius:9px;padding:6px 12px;font-size:12px;cursor:pointer}
.dm-btn:hover{background:#f7f8f9}
.dm-btn.danger{color:#b42318;border-color:#f0c8c3}
.dm-btn.primary{background:#1f2328;border-color:#1f2328;color:#fff;padding:9px 18px;font-size:13px;font-weight:600}
.dm-btn.primary:hover{opacity:.9}
.dm-btn:disabled{opacity:.5;cursor:default}
.dm-field{margin-bottom:14px}
.dm-label{display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:#374151}
.dm-input,.dm-select{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d8dbe0;border-radius:10px;
  font:14px/1.4 inherit;color:#1f2328;background:#fff}
.dm-input:focus,.dm-select:focus{outline:2px solid rgba(31,35,40,.15);border-color:#1f2328}
.dm-help{font-size:12px;color:#6b7280;margin:6px 0 0}
.dm-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dm-status{font-size:12px;color:#6b7280}
.dm-status.err{color:#b42318}
.dm-status.ok{color:#177245}
.dm-empty{font-size:13px;color:#9ca3af;padding:4px 0}
.dm-note{background:#f8f9fa;border:1px solid #eceef1;border-radius:10px;padding:10px 12px;font-size:12px;color:#4b5563}
@media (prefers-color-scheme:dark){
  .dm-page{color:#e6e8ea}
  .dm-card{background:#1b1f23;border-color:#2b3138}
  .dm-input,.dm-select,.dm-btn{background:#22262b;color:#e6e8ea;border-color:#3a4046}
  .dm-btn.primary{background:#e6e8ea;color:#1b1f23;border-color:#e6e8ea}
  .dm-row{border-color:#2b3138}
  .dm-note{background:#22262b;border-color:#2b3138}
  .dm-h1,.dm-row-id{color:#e6e8ea}
}`;

    const STYLE_TAG_ID = 'dsh-mail/accounts.css';

    /** 样式只挂一次；重复挂载（HMR）时覆盖旧标签，避免残留。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      let tag = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]');
      if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-mail';
        tag.dataset.pluginCss = STYLE_TAG_ID;
        document.head.appendChild(tag);
      }
      tag.textContent = CSS;
    }

    /** 侧栏图标：一个描边信封，画法与宿主原生图标一致（24 视框 / 1.7 描边）。 */
    function MailIcon() {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2, key: 'r' }),
        h('path', { d: 'M3.5 7.5 12 13l8.5-5.5', key: 'p' }),
      );
    }

    const PROVIDER_FALLBACK = [
      { id: 'qq', label: 'QQ 邮箱' },
      { id: '163', label: '163 邮箱' },
      { id: '126', label: '126 邮箱' },
      { id: 'gmail', label: 'Gmail' },
      { id: 'outlook', label: 'Outlook' },
    ];

    async function callApi(method, body) {
      const res = await fetch(API, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      let data = {};
      try {
        data = await res.json();
      } catch {
        /* 非 JSON 也要给出可读错误 */
      }
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data;
    }

    function providerLabel(providers, id) {
      if (!id) return '自动识别';
      const hit = providers.find((p) => p.id === id);
      return hit ? hit.label : id;
    }

    /** 主区页面。 */
    function MailAccountsPage() {
      const [saved, setSaved] = react.useState([]);
      const [configAccounts, setConfigAccounts] = react.useState([]);
      const [providers, setProviders] = react.useState(PROVIDER_FALLBACK);
      const [loading, setLoading] = react.useState(true);
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState({ text: '', kind: '' });
      const [form, setForm] = react.useState({ id: '', address: '', provider: '', password: '', label: '' });
      // 编辑时提示「留空不改」，其余时候提示去哪拿授权码
      const [editingHasSecret, setEditingHasSecret] = react.useState(false);

      const refresh = react.useCallback(async () => {
        try {
          const data = await callApi('GET');
          setSaved(Array.isArray(data.saved) ? data.saved : []);
          setConfigAccounts(Array.isArray(data.config) ? data.config : []);
          if (Array.isArray(data.providers) && data.providers.length > 0) setProviders(data.providers);
          setLoading(false);
        } catch (error) {
          setLoading(false);
          setStatus({ text: '读取失败：' + error.message, kind: 'err' });
        }
      }, []);

      react.useEffect(() => {
        ensureStyle();
        refresh();
        // 挂载成功后回打一次，宿主日志里能看到 "UI mounted"（排查时非常有用）
        try {
          fetch('/dsh-mail/mounted', { method: 'POST', cache: 'no-store' }).catch(() => {});
        } catch {
          /* 老版本宿主没有这条路由 */
        }
      }, []);

      const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

      const resetForm = () => {
        setForm({ id: '', address: '', provider: '', password: '', label: '' });
        setEditingHasSecret(false);
        setStatus({ text: '', kind: '' });
      };

      const submit = async (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!form.address.trim()) {
          setStatus({ text: '请先填邮箱地址', kind: 'err' });
          return;
        }
        setBusy(true);
        setStatus({ text: '保存中…', kind: '' });
        try {
          const payload = {
            action: 'save',
            account: {
              id: form.id || undefined,
              address: form.address.trim(),
              provider: form.provider || undefined,
              label: form.label.trim() || undefined,
            },
          };
          if (form.password) payload.account.password = form.password;
          const data = await callApi('POST', payload);
          setStatus({ text: '已保存 ' + (data.id || form.address), kind: 'ok' });
          resetForm();
          await refresh();
        } catch (error) {
          setStatus({ text: '保存失败：' + error.message, kind: 'err' });
        } finally {
          setBusy(false);
        }
      };

      const startEdit = (account) => {
        setForm({
          id: account.id,
          address: account.address || '',
          provider: account.provider || '',
          password: '',
          label: account.label || '',
        });
        setEditingHasSecret(Boolean(account.hasSecret));
        setStatus({ text: '', kind: '' });
      };

      const remove = async (account) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('删除账号 ' + account.id + '？')) return;
        }
        setBusy(true);
        try {
          await callApi('POST', { action: 'delete', id: account.id });
          setStatus({ text: '已删除 ' + account.id, kind: 'ok' });
          await refresh();
        } catch (error) {
          setStatus({ text: '删除失败：' + error.message, kind: 'err' });
        } finally {
          setBusy(false);
        }
      };

      const rows = (list, editable) =>
        list.map((a) =>
          h(
            'div',
            { className: 'dm-row', key: (editable ? 'saved:' : 'cfg:') + a.id },
            h(
              'div',
              { className: 'dm-row-main' },
              h('div', { className: 'dm-row-id' }, a.id),
              h(
                'div',
                { className: 'dm-row-meta' },
                (a.address || '(未填地址)') + ' · ' + providerLabel(providers, a.provider),
              ),
            ),
            h(
              'span',
              { className: 'dm-badge ' + (a.hasSecret ? 'ok' : 'warn') },
              a.hasSecret ? '已存授权码' : '缺授权码',
            ),
            editable
              ? h(
                  'button',
                  { className: 'dm-btn', type: 'button', onClick: () => startEdit(a) },
                  '编辑',
                )
              : null,
            editable
              ? h(
                  'button',
                  {
                    className: 'dm-btn danger',
                    type: 'button',
                    onClick: () => remove(a),
                    disabled: busy,
                  },
                  '删除',
                )
              : null,
          ),
        );

      return h(
        'div',
        { className: 'dm-page', 'data-dsh-mail-panel': PANEL_ID },
        h(
          'div',
          null,
          h('h1', { className: 'dm-h1' }, '邮件账号'),
          h('p', { className: 'dm-sub' }, '这里填的账号供对话里的邮件工具使用；保存后立即生效，不需要重启。'),
        ),

        h(
          'section',
          { className: 'dm-card' },
          h('h2', { className: 'dm-card-title' }, '已保存的账号'),
          loading
            ? h('div', { className: 'dm-empty' }, '加载中…')
            : saved.length === 0
              ? h('div', { className: 'dm-empty' }, '还没有保存任何账号。用下面的表单加一个。')
              : rows(saved, true),
        ),

        configAccounts.length > 0
          ? h(
              'section',
              { className: 'dm-card' },
              h('h2', { className: 'dm-card-title' }, '来自 cordis.patch.yml'),
              rows(configAccounts, false),
              h('p', { className: 'dm-note' }, '这些账号写在 DSH 的配置文件里，本页不直接改它；要改请编辑 profile 的 cordis.patch.yml。'),
            )
          : null,

        h(
          'section',
          { className: 'dm-card' },
          h('h2', { className: 'dm-card-title' }, form.id ? '编辑账号 ' + form.id : '添加账号'),
          h(
            'form',
            { onSubmit: submit, autoComplete: 'off' },
            h(
              'div',
              { className: 'dm-field' },
              h('label', { className: 'dm-label', htmlFor: 'dm-f-address' }, '邮箱地址'),
              h('input', {
                id: 'dm-f-address',
                className: 'dm-input',
                value: form.address,
                onChange: update('address'),
                placeholder: '例如 123456789@qq.com',
                spellCheck: false,
              }),
            ),
            h(
              'div',
              { className: 'dm-field' },
              h('label', { className: 'dm-label', htmlFor: 'dm-f-provider' }, '服务商'),
              h(
                'select',
                { id: 'dm-f-provider', className: 'dm-select', value: form.provider, onChange: update('provider') },
                h('option', { value: '' }, '自动识别（按域名）'),
                providers.map((p) => h('option', { value: p.id, key: p.id }, p.label + '（' + p.id + '）')),
              ),
              h('p', { className: 'dm-help' }, '留空会按域名自动识别（qq / 163 / 126 / gmail / outlook …）。'),
            ),
            h(
              'div',
              { className: 'dm-field' },
              h('label', { className: 'dm-label', htmlFor: 'dm-f-password' }, '授权码'),
              h('input', {
                id: 'dm-f-password',
                className: 'dm-input',
                type: 'password',
                value: form.password,
                onChange: update('password'),
                placeholder: editingHasSecret ? '已保存，留空表示不修改' : '邮箱服务商给的授权码（不是登录密码）',
                autoComplete: 'new-password',
              }),
              h(
                'p',
                { className: 'dm-help' },
                'QQ 邮箱：设置 → 账户 → IMAP/SMTP 服务里开启并获取，16 位。',
              ),
            ),
            h(
              'div',
              { className: 'dm-field' },
              h('label', { className: 'dm-label', htmlFor: 'dm-f-label' }, '备注（可选）'),
              h('input', {
                id: 'dm-f-label',
                className: 'dm-input',
                value: form.label,
                onChange: update('label'),
                placeholder: '例如 工作邮箱',
              }),
            ),
            h(
              'div',
              { className: 'dm-actions' },
              h('button', { className: 'dm-btn primary', type: 'submit', disabled: busy }, '保存'),
              h('button', { className: 'dm-btn', type: 'button', onClick: resetForm, disabled: busy }, '清空'),
              h('span', { className: 'dm-status ' + (status.kind || '') }, status.text),
            ),
          ),
        ),
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      try {
        ensureStyle();
      } catch {
        /* 样式挂了不影响注册 */
      }
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: () => '邮件',
          },
          MailIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          MailAccountsPage,
        ),
      );
    }

    module.exports.PANEL_ID = PANEL_ID;
    module.exports.MailAccountsPage = MailAccountsPage;
    module.exports.MailIcon = MailIcon;
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
