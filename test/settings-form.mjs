/**
 * 配置表单契约测试。
 *
 * 这个插件不自建 UI：它声明 `Config`，由 DSH 的设置页派生表单。所以「用户能不能
 * 在界面里填账号和授权码」这件事，完全取决于这份 schema 的四个性质，而它们都是
 * 可以在本地断言的：
 *
 *   1. 可编辑字段带 `.volatile()` —— 不带就不会出现在表单里，也不会成为活引用。
 *   2. 密文字段带 `role('secret')` —— 设置层据此把值从跨进程的数据里摘掉。
 *   3. 密文字段没有默认值、也不是 required —— 否则表单会逼用户重填，或把默认值
 *      当成真实值。
 *   4. schema 足够宽容 —— 用户在 YAML 或表单里写错一个标量，也绝不能导致插件
 *      激活失败（那样工具会直接消失，连错在哪都看不到）。
 *
 * 另外验证活引用语义：改配置后**下一次工具调用**就生效，不需要重启。
 *
 * 运行： node test/settings-form.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const imp = (rel) => import(pathToFileURL(at(rel)).href);

const { Config } = await imp('lib/index.js');
const { normalizeConfig, publicAccount, unwrapVolatile } = await imp('lib/config.js');

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}\n       ${error.message}`);
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

console.log('\n== A. Config 是设置页表单的来源 ==');
// 用活的 schema 对象断言，而不是 toJSON()：设置服务读的就是 schema.meta / .dict / .inner。
check('导出 Config，且它是可调用的 schema', () => {
  assert.equal(typeof Config, 'function');
  assert.equal(typeof Config.toJSON, 'function');
  assert.equal(typeof Config.dict, 'object', 'Config 必须是对象 schema');
});
check('该可编辑的顶层字段都标了 volatile（否则表单里根本不出现）', () => {
  for (const key of ['defaultAccount', 'attachmentDir', 'maxBodyChars', 'timeoutMs', 'accounts']) {
    assert.equal(Config.dict[key]?.meta?.volatile, true, `${key} 必须是 volatile`);
  }
});
check('accounts 内层字段靠外层 volatile 生效（isVolatilePath 会一路回溯）', () => {
  const accounts = Config.dict.accounts;
  assert.equal(accounts.meta.volatile, true);
  assert.equal(accounts.inner?.type, 'object', 'accounts 的元素必须是对象');
  assert.ok(Object.keys(accounts.inner.dict).length >= 20, '账号字段数量偏少，可能漏了字段');
});
check('volatile 之内不能再有 volatile（否则活引用快照会失败、插件激活报错）', () => {
  const nested = [];
  const walk = (node, underVolatile, path_) => {
    const isVol = node?.meta?.volatile === true;
    if (isVol && underVolatile) nested.push(path_);
    for (const [k, v] of Object.entries(node?.dict ?? {})) walk(v, underVolatile || isVol, `${path_}.${k}`);
    if (node?.inner) walk(node.inner, underVolatile || isVol, `${path_}[]`);
  };
  walk(Config, false, 'Config');
  assert.deepEqual(nested, [], `这些字段被标成了嵌套 volatile：${nested.join(', ')}`);
});
check('三个密文字段都带 role(secret)', () => {
  const fields = Config.dict.accounts.inner.dict;
  for (const key of ['password', 'authCode', 'token']) {
    assert.equal(fields[key]?.meta?.role, 'secret', `${key} 必须是 secret 角色`);
  }
});
check('密文字段没有默认值（默认值会绕过脱敏被展示）', () => {
  const fields = Config.dict.accounts.inner.dict;
  for (const key of ['password', 'authCode', 'token']) {
    assert.equal(fields[key].meta.default, undefined, `${key} 不能有默认值`);
  }
});
check('密文字段不是 required（否则表单会逼用户每次重填）', () => {
  const fields = Config.dict.accounts.inner.dict;
  for (const key of ['password', 'authCode', 'token']) {
    assert.notEqual(fields[key].meta.required, true, `${key} 不能是 required`);
  }
});
check('没有任何字段是 required（半填的表单不能让插件激活失败）', () => {
  const walk = (node, path_) => {
    if (node?.meta?.required === true) throw new Error(`${path_} 被标成 required`);
    for (const [k, v] of Object.entries(node?.dict ?? {})) walk(v, `${path_}.${k}`);
    if (node?.inner) walk(node.inner, `${path_}[]`);
  };
  walk(Config, 'Config');
});
check('每个字段都有中文说明（表单里直接显示给用户看）', () => {
  const missing = [];
  const walk = (node, path_) => {
    if (node?.type === 'object' || node?.type === 'array') {
      if (typeof node.meta?.description !== 'string' || node.meta.description === '') missing.push(path_);
    }
    for (const [k, v] of Object.entries(node?.dict ?? {})) walk(v, `${path_}.${k}`);
    if (node?.inner) walk(node.inner, `${path_}[]`);
  };
  walk(Config, 'Config');
  assert.deepEqual(missing, [], `这些字段缺 description：${missing.join(', ')}`);
});

console.log('\n== B. 宽容性：写错一个标量不能让插件激活失败 ==');
check('随包发布的 cordis.patch.yml 里那份 config 能通过校验', () => {
  const patch = YAML.parse(readFileSync(at('cordis.patch.yml'), 'utf8'));
  const row = patch
    .flatMap((entry) => entry?.insert ?? [])
    .find((entry) => entry?.name === 'dsh-mail');
  assert.ok(row, 'cordis.patch.yml 里没有 name 为 dsh-mail 的 insert 行');
  assert.doesNotThrow(() => Config(row.config), '包里自带的 config 竟然通不过自己的 schema');
});
check('各种手写变体都能通过（含引号标量、null、空账号、未知字段）', () => {
  const samples = {
    '空对象': {},
    'defaultAccount: null': { defaultAccount: null, accounts: [] },
    '引号包裹的端口': { accounts: [{ id: 'x', imap: { host: 'h', port: '993' } }] },
    '引号包裹的布尔': { accounts: [{ id: 'x', imap: { host: 'h', port: 993, secure: 'false' } }] },
    '引号包裹的数值字段': { maxBodyChars: '5000', timeoutMs: '1000', accounts: [] },
    '未知多余字段': { accounts: [], typoField: 'x', anotherOne: 1 },
    '缺 id 的账号': { accounts: [{ address: 'a@b.com' }] },
    '账号是 null': { accounts: [null] },
    '完全空的账号': { accounts: [{}] },
  };
  for (const [name, sample] of Object.entries(samples)) {
    assert.doesNotThrow(() => Config(sample), `${name} 让 Config 抛错`);
  }
});

console.log('\n== C. 活引用：改设置后下一次调用即生效，无需重启 ==');
check('unwrapVolatile 解开活引用、数组与嵌套', () => {
  // 注意：活引用的快照里不能再放活引用（createVolatile 会因快照含函数而抛错），
  // 所以「嵌套」指的是普通对象里嵌活引用，这正是宿主解析出的 config 的形状。
  const inner = createVolatile({ host: 'imap.example.com', port: 993 });
  const list = createVolatile([{ id: 'a' }, { id: 'b' }]);
  const plain = unwrapVolatile({
    accounts: list,
    defaultAccount: createVolatile('a'),
    endpoints: { imap: inner },
  });
  assert.deepEqual(plain, {
    accounts: [{ id: 'a' }, { id: 'b' }],
    defaultAccount: 'a',
    endpoints: { imap: { host: 'imap.example.com', port: 993 } },
  });
});
check('unwrapVolatile 不因自引用对象而栈溢出', () => {
  const cyclic = { id: 'loop' };
  cyclic.self = cyclic;
  const plain = unwrapVolatile(cyclic);
  assert.equal(plain.id, 'loop');
  assert.equal(plain.self, undefined, '环上应被截断');
});
check('同一份 config 每次读取都反映活引用的当前值（这就是免重启的原因）', () => {
  const accountsRef = createVolatile([{ id: 'qq', address: 'first@qq.com', authCode: 'CODE-ONE' }]);
  const liveConfig = { defaultAccount: createVolatile('qq'), accounts: accountsRef };

  const before = normalizeConfig(liveConfig, {});
  assert.equal(before.accounts.length, 1);
  assert.equal(before.accounts[0].address, 'first@qq.com');
  assert.equal(before.accounts[0]._secret, 'CODE-ONE');

  // 模拟用户在设置页里改了地址和授权码
  updateVolatile(accountsRef, createVolatile([{ id: 'qq', address: 'second@qq.com', authCode: 'CODE-TWO' }]));

  const after = normalizeConfig(liveConfig, {});
  assert.equal(after.accounts[0].address, 'second@qq.com', '地址没有随活引用更新');
  assert.equal(after.accounts[0]._secret, 'CODE-TWO', '授权码没有随活引用更新');
  assert.equal(publicAccount(after.accounts[0]).hasSecret, true);
});
check('活引用换成空列表后，工具会报告「未配置账号」而不是崩掉', () => {
  const accountsRef = createVolatile([]);
  const liveConfig = { accounts: accountsRef };
  const first = normalizeConfig(liveConfig, {});
  assert.equal(first.accounts.length, 0);
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0], /未配置任何邮箱账号/);

  // 用户在设置页里加了一个完整可用的账号
  updateVolatile(accountsRef, createVolatile([{ id: 'qq', address: 'x@qq.com', provider: 'qq', authCode: 'c' }]));
  const second = normalizeConfig(liveConfig, {});
  assert.equal(second.accounts.length, 1);
  assert.equal(second.accounts[0]._ready, true);
  assert.deepEqual(second.problems, [], '补上账号后不应再有配置问题');
});

console.log('\n== D. 字符串布尔不能被理解反 ==');
check('secure/requireTLS/appendToSent 接受字符串并正确解释', () => {
  const c = normalizeConfig({
    accounts: [
      {
        id: 'x',
        address: 'a@b.com',
        password: 'p',
        appendToSent: 'false',
        imap: { host: 'h', port: 993, secure: 'false' },
        smtp: { host: 'h', port: 587, secure: 'false', requireTLS: 'true' },
      },
    ],
  });
  const a = c.accounts[0];
  assert.equal(a.imap.secure, false, '"false" 被当成了 true —— 会静默降级成明文连接');
  assert.equal(a.smtp.secure, false);
  assert.equal(a.smtp.requireTLS, true);
  assert.equal(a.appendToSent, false);
});
check('字符串 "true"/"yes"/"1" 都被认成真', () => {
  for (const truthy of ['true', 'TRUE', 'yes', 'on', '1']) {
    const c = normalizeConfig({ accounts: [{ id: 'x', address: 'a@b.com', password: 'p', appendToSent: truthy }] });
    assert.equal(c.accounts[0].appendToSent, true, `${truthy} 应为 true`);
  }
});
check('未提供时用回退值（appendToSent 默认 true，imap.secure 默认 true）', () => {
  const c = normalizeConfig({ accounts: [{ id: 'x', address: 'a@b.com', password: 'p' }] });
  assert.equal(c.accounts[0].appendToSent, true);
  assert.equal(c.accounts[0].imap.secure, true);
});

console.log('\n====================================================');
if (failures.length > 0) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`通过 ${passed} 项，失败 0 项`);
console.log('全部通过。');