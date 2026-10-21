/**
 * 账号持久化：把界面里填的账号存成一个独立的 JSON 文件。
 *
 * 为什么不写回 profile 的 `cordis.patch.yml`：那份文件是 DSH 的启动配置，写坏一个
 * 缩进就起不来。界面只是「用户输入的一条记录」，用一个自己的小文件更安全，也更容易
 * 备份、删除和迁移。
 *
 * 存放位置（按优先级）：
 *   1. `DSH_MAIL_DATA_DIR`            —— 测试与自定义部署用
 *   2. `<DSH_PROFILE_DIR>/dsh-mail/`   —— 正常安装（每个 profile 一份）
 *   3. `~/.dsh/dsh-mail/`              —— 兜底
 *
 * 文件格式：`{ "version": 1, "accounts": [ { id, provider, address, password, label } ] }`
 * 授权码是明文。这一点在 README 里写清楚了，没有假装加密；不想落盘就用 passwordEnv。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ACCOUNTS_FILE_VERSION = 1;

/** Directory the plugin keeps its own state in. */
export function resolveDataDir(env = process.env) {
  const override = str(env.DSH_MAIL_DATA_DIR);
  if (override) return override;
  const profileDir = str(env.DSH_PROFILE_DIR);
  if (profileDir) return join(profileDir, 'dsh-mail');
  return join(str(env.DSH_HOME) ?? join(homedir(), '.dsh'), 'dsh-mail');
}

export function accountsFilePath(env = process.env) {
  return join(resolveDataDir(env), 'accounts.json');
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Read the saved accounts. A missing or unreadable file is "no saved accounts",
 * never an error: the plugin must still start and report its own state.
 */
export function readAccountsFile(env = process.env, path = accountsFilePath(env)) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw?.accounts;
    const accounts = Array.isArray(list) ? list.filter((a) => a && typeof a === 'object') : [];
    return { path, accounts, exists: true };
  } catch (error) {
    return { path, accounts: [], exists: false, error: error?.code === 'ENOENT' ? undefined : String(error?.message ?? error) };
  }
}

/**
 * Write the account list atomically (temp file + rename) so a crash mid-write
 * can never leave a half-parsed config behind.
 */
export function writeAccountsFile(accounts, env = process.env, path = accountsFilePath(env)) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && typeof a === 'object');
  const payload = { version: ACCOUNTS_FILE_VERSION, accounts: list };
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return { path, count: list.length };
}

/** Keep only the fields the account file is allowed to carry, and normalise them. */
export function sanitizeAccountEntry(input) {
  const a = input && typeof input === 'object' ? input : {};
  const address = str(a.address) ?? str(a.email);
  const provider = str(a.provider);
  const id = str(a.id) ?? (address ? address.split('@')[0] : undefined);
  if (!id) return null;
  const entry = { id };
  if (provider) entry.provider = provider;
  if (address) entry.address = address;
  const secret = str(a.password) ?? str(a.authCode);
  if (secret) entry.password = secret;
  const label = str(a.label);
  if (label) entry.label = label;
  return entry;
}

/**
 * Merge the config-declared accounts with the ones saved from the UI.
 *
 * The saved file wins on an id collision: the user's most recent edit came from
 * the UI, so it should beat a stale line in `cordis.patch.yml`. Accounts that
 * only exist in the config still show up.
 */
export function mergeAccounts(configAccounts, savedAccounts) {
  const first = Array.isArray(savedAccounts) ? savedAccounts : [];
  const second = Array.isArray(configAccounts) ? configAccounts : [];
  const out = [];
  const seen = new Set();
  for (const entry of [...first, ...second]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = str(entry.id) ?? str(entry.address) ?? str(entry.email);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(entry);
  }
  return out;
}
