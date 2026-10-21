/**
 * 账号界面的离线测试。
 *
 * 现在界面是**正式客户端插件**（lib/client.js）：左侧栏一行 + 主区一页。它不是普通 ESM
 * 模块，而是宿主外壳用模块加载器求值的 bundle —— `window.__ModuleLoader__.load({id, factory})`，
 * 且 `factory(require)` 只能拿到 react / jsx-runtime / primitives 三个种子。
 *
 * 所以这里做三件事：
 *   1. 用假的 `__ModuleLoader__` + 假 `require` **真的把 bundle 跑一遍**，验证它导出的
 *      `apply` 往哪两个槽位注册、注册对象的 id 与 key 是否一致（不一致宿主会直接抛）。
 *   2. 用**桩 React** 把页面组件调用一次，确认渲染树里有标题、输入框、保存按钮——这正是
 *      「入口在、页面空白」那条失败路径。
 *   3. 对 JSON 接口发真实 HTTP 请求，验证增删改、留空不改授权码、跨站拒绝。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test', 'setup-ui');
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
}
async function acheck(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
process.env.DSH_MAIL_DATA_DIR = tmp;

const { apply: hostApply } = await imp('lib/index.js');
const { createSetupApi, rejectReason, isLoopbackHostname } = await imp('lib/setup-routes.js');
const { mergeAccounts, readAccountsFile, resolveDataDir, sanitizeAccountEntry, writeAccountsFile } =
  await imp('lib/accounts-file.js');

// ---------------------------------------------------------------------------
// 加载客户端 bundle：假的 __ModuleLoader__ + 假的 require
// ---------------------------------------------------------------------------
const CLIENT_SRC = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

/** 极简 React 桩：足够让页面组件跑完一次渲染并把树交回来。 */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useRef(value) {
    return { current: value };
  },
  Fragment: Symbol('Fragment'),
};

/** 只收集文本，用于断言「页面上真的有这些字」。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === 'object' && 'children' in node) {
    collectText(node.children, out);
    return out;
  }
  return out;
}

function loadClientBundle() {
  const styleTags = [];
  const fakeDocument = {
    head: { appendChild: (el) => styleTags.push(el) },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  };
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', CLIENT_SRC)(fakeWindow, fakeDocument);
  assert.ok(captured, 'bundle 没有调用 __ModuleLoader__.load —— 宿主不会认这个文件');
  const requireStub = (name) => (name === 'react' ? reactStub : {});
  const exportsObj = captured.factory(requireStub);
  return { spec: captured, exports: exportsObj, styleTags };
}

console.log('\n== 1. 客户端 bundle 的形态 ==');
const bundle = loadClientBundle();

check('id 与包名一致', () => {
  assert.equal(bundle.spec.id, 'dsh-mail');
});
check('导出 apply / inject / 页面与图标', () => {
  assert.equal(typeof bundle.exports.apply, 'function');
  assert.ok(Array.isArray(bundle.exports.inject), 'inject 必须是数组');
  assert.equal(typeof bundle.exports.MailAccountsPage, 'function');
  assert.equal(typeof bundle.exports.MailIcon, 'function');
});
check('声明依赖 slots 服务', () => {
  assert.ok(bundle.exports.inject.includes('slots'), `实际 inject: ${JSON.stringify(bundle.exports.inject)}`);
});
check('bundle 里没有 import/export 语句（模块加载器不认）', () => {
  assert.ok(!/^\s*import\s/m.test(CLIENT_SRC), '出现了 import 语句');
  assert.ok(!/^\s*export\s/m.test(CLIENT_SRC), '出现了 export 语句');
});

console.log('\n== 2. 槽位注册 ==');
const registrations = [];
const fakeCtx = {
  slots: {
    inject(name, cb) {
      cb();
      return () => {};
    },
    register(spec, component) {
      registrations.push({ spec, component });
      return () => {};
    },
  },
};
bundle.exports.apply(fakeCtx);

check('注册了两个槽位：侧栏行 + 主区页面', () => {
  assert.equal(registrations.length, 2, `注册了 ${registrations.length} 个`);
  assert.deepEqual(registrations.map((r) => r.spec.name).sort(), ['main', 'sidebar.panellist']);
});
check('侧栏行带 id / order / label', () => {
  const row = registrations.find((r) => r.spec.name === 'sidebar.panellist');
  assert.ok(row, '没注册侧栏行');
  assert.equal(row.spec.id, bundle.exports.PANEL_ID);
  assert.equal(typeof row.spec.order, 'number');
  assert.equal(row.spec.label(), '邮件', '侧栏标题不对');
  assert.equal(typeof row.component, 'function', '侧栏行需要一个图标组件');
});
check('主区页面的 key 与侧栏行 id 一致（不一致宿主会抛）', () => {
  const row = registrations.find((r) => r.spec.name === 'sidebar.panellist');
  const page = registrations.find((r) => r.spec.name === 'main');
  assert.ok(page, '没注册主区页面');
  assert.equal(page.spec.key, row.spec.id);
  assert.equal(typeof page.component, 'function');
});
check('样式只挂一个 <style>，带幂等标记', () => {
  assert.equal(bundle.styleTags.length, 1, `挂了 ${bundle.styleTags.length} 个 style`);
  assert.equal(bundle.styleTags[0].dataset.pluginCss, 'dsh-mail/accounts.css');
  assert.ok(String(bundle.styleTags[0].textContent).includes('.dm-page'), '样式里没有页面类名');
});

console.log('\n== 3. 页面能渲染出真实内容 ==');
const pageComponent = registrations.find((r) => r.spec.name === 'main').component;
let pageText = '';
await acheck('页面组件可调用并产出标题/表单/按钮', async () => {
  const tree = pageComponent({});
  const texts = collectText(tree).join(' ');
  pageText = texts;
  for (const want of ['邮件账号', '已保存的账号', '邮箱地址', '服务商', '授权码', '保存']) {
    assert.ok(texts.includes(want), `渲染结果里没有「${want}」：${texts.slice(0, 200)}`);
  }
});
check('渲染树里真的有一个 password 输入框', () => {
  const tree = pageComponent({});
  const flat = JSON.stringify(collectAllNodes(tree));
  assert.ok(flat.includes('"type":"password"'), '没有找到 password 类型的输入框');
});
check('页面不会渲染出任何授权码明文', () => {
  assert.ok(!/value":\s*"[^"]{8,}"/.test(JSON.stringify(collectAllNodes(pageComponent({})))), '疑似把值渲染出来了');
});

/** 收集整棵树的所有节点（含 props），用于检查元素属性。 */
function collectAllNodes(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectAllNodes(child, out);
    return out;
  }
  if (node && typeof node === 'object' && 'children' in node) {
    out.push({ type: typeof node.type === 'string' ? node.type : 'component', props: node.props });
    collectAllNodes(node.children, out);
  }
  return out;
}

console.log('\n== 4. 账号文件 ==');
check('数据目录优先取 DSH_MAIL_DATA_DIR', () => {
  assert.equal(resolveDataDir({ DSH_MAIL_DATA_DIR: 'D:/x' }), 'D:/x');
});
check('其次取 DSH_PROFILE_DIR 下的子目录', () => {
  assert.equal(resolveDataDir({ DSH_PROFILE_DIR: 'D:/p' }).replace(/\\/g, '/'), 'D:/p/dsh-mail');
});
check('写入后能读回来', () => {
  const env = { DSH_MAIL_DATA_DIR: path.join(tmp, 'store') };
  writeAccountsFile([{ id: 'qq', address: 'a@qq.com', password: 'secret-1' }], env);
  const { accounts, exists } = readAccountsFile(env);
  assert.equal(exists, true);
  assert.deepEqual(accounts.map((a) => a.id), ['qq']);
  assert.equal(accounts[0].password, 'secret-1');
});
check('文件不存在时是「没有账号」，不是报错', () => {
  const { accounts, exists } = readAccountsFile({ DSH_MAIL_DATA_DIR: path.join(tmp, 'nope') });
  assert.deepEqual(accounts, []);
  assert.equal(exists, false);
});
check('sanitizeAccountEntry 丢掉多余字段', () => {
  const entry = sanitizeAccountEntry({ id: 'qq', address: 'a@qq.com', password: 'p', evil: 'x', imap: {} });
  assert.deepEqual(Object.keys(entry).sort(), ['address', 'id', 'password']);
});
check('界面保存的账号覆盖配置里的同名账号', () => {
  const merged = mergeAccounts([{ id: 'qq', address: 'old@qq.com' }], [{ id: 'qq', address: 'new@qq.com' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].address, 'new@qq.com');
});
check('只在配置里的账号仍然保留', () => {
  const merged = mergeAccounts([{ id: 'work', address: 'w@corp.com' }], [{ id: 'qq', address: 'n@qq.com' }]);
  assert.deepEqual(merged.map((a) => a.id).sort(), ['qq', 'work']);
});

console.log('\n== 5. 跨站防护 ==');
check('回环 Host 放行', () => {
  assert.equal(rejectReason({ host: '127.0.0.1:58069' }), null);
  assert.equal(rejectReason({ host: 'localhost:1' }), null);
});
check('非回环 Host 拒绝（挡 DNS 重绑定）', () => {
  assert.equal(rejectReason({ host: 'evil.com' }), 'host-not-loopback');
  assert.equal(rejectReason({ host: '127.0.0.1.evil.com' }), 'host-not-loopback');
});
check('cross-site 请求拒绝', () => {
  assert.equal(rejectReason({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), 'cross-site');
});
check('桌面壳的 dsh-app:// 来源放行', () => {
  assert.equal(rejectReason({ host: '127.0.0.1:1', origin: 'dsh-app://app' }), null);
});
check('外部网页来源拒绝', () => {
  assert.equal(rejectReason({ host: '127.0.0.1:1', origin: 'https://evil.com' }), 'origin-not-loopback');
});
check('isLoopbackHostname 不误判相似域名', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false);
});

console.log('\n== 6. JSON 接口（真实 HTTP） ==');
const env = { DSH_MAIL_DATA_DIR: path.join(tmp, 'api') };
const api = createSetupApi({
  env,
  providers: [{ id: 'qq', label: 'QQ 邮箱' }],
  listConfig: () => [{ id: 'cfg', address: 'cfg@corp.com', provider: 'custom', label: null, hasSecret: true }],
});
const server = http.createServer(api.handle);
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}/dsh-mail/api/accounts`;
const call = (init) => fetch(base, init).then(async (res) => ({ status: res.status, body: await res.json() }));
const post = (payload, headers) =>
  call({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });

await acheck('GET 返回空列表 + 服务商 + 配置账号', async () => {
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.deepEqual(body.saved, []);
  assert.equal(body.providers[0].id, 'qq');
  assert.equal(body.config[0].id, 'cfg');
});
await acheck('POST save 真的写进文件', async () => {
  const { status, body } = await post({ action: 'save', account: { address: '123@qq.com', password: 'auth-code-1' } });
  assert.equal(status, 200);
  assert.equal(body.id, '123');
  const { accounts } = readAccountsFile(env);
  assert.equal(accounts[0].password, 'auth-code-1');
});
await acheck('GET 不回传授权码，只说「已存」', async () => {
  const { body } = await call();
  assert.equal(body.saved[0].hasSecret, true);
  assert.ok(!JSON.stringify(body).includes('auth-code-1'), '授权码泄漏到了浏览器方向');
});
await acheck('编辑时留空密码 = 保留原授权码', async () => {
  await post({ action: 'save', account: { id: '123', address: '123@qq.com', label: '改名了' } });
  const { accounts } = readAccountsFile(env);
  assert.equal(accounts[0].password, 'auth-code-1', '授权码被清空了');
  assert.equal(accounts[0].label, '改名了');
});
await acheck('邮箱地址缺 @ 时拒绝写入', async () => {
  const { status, body } = await post({ action: 'save', account: { address: 'not-an-email' } });
  assert.equal(status, 400);
  assert.match(body.error, /@/);
});
await acheck('跨站 POST 被拒（403）且不改数据', async () => {
  const before = readAccountsFile(env).accounts.length;
  const { status } = await post({ action: 'save', account: { address: 'evil@x.com', password: 'p' } }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(status, 403);
  assert.equal(readAccountsFile(env).accounts.length, before);
});
await acheck('删除账号', async () => {
  const { status } = await post({ action: 'delete', id: '123' });
  assert.equal(status, 200);
  assert.deepEqual(readAccountsFile(env).accounts, []);
});
server.closeAllConnections?.();
server.close();

console.log('\n== 7. 挂载到宿主 web 服务 ==');
await acheck('三条路由都注册了，注销函数可批量撤销', async () => {
  const m = await imp('lib/setup-routes.js');
  const calls = [];
  let disposed = 0;
  const fake = {
    webServer: {
      register(route) {
        calls.push(route);
        return () => {
          disposed += 1;
        };
      },
    },
  };
  const dispose = m.mountSetupApi(fake, { env, providers: [] });
  assert.deepEqual(calls.map((c) => c.path).sort(), [
    '/dsh-mail/api/accounts',
    '/dsh-mail/health',
    '/dsh-mail/mounted',
  ]);
  dispose();
  assert.equal(disposed, 3, `只注销了 ${disposed} 条`);
});
await acheck('宿主没有 webServer 时是安全的 no-op', async () => {
  const m = await imp('lib/setup-routes.js');
  assert.doesNotThrow(() => m.mountSetupApi({}, {}));
  assert.doesNotThrow(() => m.mountSetupApi(undefined, {}));
});

console.log('\n== 8. 页面保存 → 工具立刻看得见 ==');
await acheck('存一个 QQ 账号，mail_accounts 就能列出来', async () => {
  const e2eDir = path.join(tmp, 'e2e');
  process.env.DSH_MAIL_DATA_DIR = e2eDir;
  writeAccountsFile([{ id: 'qq', provider: 'qq', address: '123456789@qq.com', password: 'auth-code-e2e' }], {
    DSH_MAIL_DATA_DIR: e2eDir,
  });
  const tools = new Map();
  hostApply({ tools: { register: (t) => (tools.set(t.name, t), t) } }, { accounts: [] });
  const out = await tools.get('mail_accounts').execute({}, {});
  assert.ok(out.includes('123456789@qq.com'), `没列出页面存进去的账号：${out.slice(0, 200)}`);
  assert.ok(!out.includes('auth-code-e2e'), '授权码不该出现在工具输出里');
});
await acheck('猜不出服务商的地址不会打印 undefined（回归）', async () => {
  const dir = path.join(tmp, 'no-host');
  process.env.DSH_MAIL_DATA_DIR = dir;
  writeAccountsFile([{ id: 'probe', address: 'probe@example.com', password: 'p' }], { DSH_MAIL_DATA_DIR: dir });
  const tools = new Map();
  hostApply({ tools: { register: (t) => (tools.set(t.name, t), t) } }, { accounts: [] });
  const out = await tools.get('mail_accounts').execute({}, {});
  assert.ok(!out.includes('undefined'), `输出里出现了 undefined：${out}`);
  assert.ok(out.includes('未填'), '应当提示服务器地址未填');
});

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）。`);
