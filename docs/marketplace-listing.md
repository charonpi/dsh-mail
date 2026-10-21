# 上架清单（dsh-mail）

这份文档是**给你用的**，不进 npm 包（`package.json` 的 `files` 不含 `docs/`）。

---

## 0. 先确定走哪条路

DSH 生态里有**三套互不相通的**市场机制。你本机 `desktop` profile 里**实际启用的只有一个**：

| # | 机制 | 你该用吗 | 发布方式 |
|---|---|---|---|
| 1 | format-1 市场索引 | 不用 | 无官方实例；要自己架 HTTPS 索引再让用户手动添加 |
| 2 | `dsh-community-market` | 不用 | 内置于 DSH Desktop |
| 3 | **`dshmarket`** | **✅ 就是它** | 向 `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提 PR |

判定依据：`C:\Users\94804\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里有 `dshmarket`。
它的目录来自 `https://awesome-dsh-plugin.com/plugins.json`，每次打开市场时实时抓取，不接受陈旧缓存。

它自己 README 里写明（原文）：

> **This repo is the market app, not the catalog.** The plugin list comes from the curated
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — to get your
> plugin listed in the market, open a PR **there** (one entry in the list; the site and this market pick it
> up automatically, usually within a day). Please don't PR plugin entries against this repo.

并且安装是**白名单**的：「Installs are restricted to sources listed in the curated registry — anything
else is rejected」。

---

## 1. 前置：先发到 npm

市场安装时**优先用 repo 验证过的 npm 包**（其次才是作者提供的 GitHub Release tarball，最后才是整仓源码），
而且只接受目录里列出的来源。所以先发 npm：

```bash
cd D:\DSHfiles\博士申请\dsh-mail

npm view dsh-mail version     # 先查名字是否已被占用；被占用了就改成你 scope 下的包名
npm test                      # 191 项，必须全绿
npm pack --dry-run            # 确认 12 个文件、不含 node_modules/test/docs

npm login
npm publish --access public   # package.json 里已设 publishConfig.access = public
npm view dsh-mail version     # 回读确认
```

若 `dsh-mail` 这个名字在 npm 上已被别人占用，就发成 `@<你的npm用户名>/dsh-mail`，并在下面的条目里把
`npm` 与 `install` 都改成那个带 scope 的名字。**包名和目录条目必须一致**，否则市场装不上。

---

## 2. 只有三项要你补

条目里其余字段我都按代码里的真实类型填好了。这三项只有你能定：

| 字段 | 怎么确定 |
|---|---|
| `owner` | 你 GitHub 的用户名/组织名（`awesome-dsh-plugin` 用它做归属） |
| `url` | 插件的公开仓库地址（`https://github.com/<owner>/dsh-mail`） |
| `category` | **必须以目录里 `categories` 对象的实际 key 为准** —— 见下 |

**关于 `category`**：合法 id 不是本地可枚举的，它们是 `plugins.json` 顶层 `categories` 映射里的 key
（形如 `Record<id, Record<语言, 名字>>`）。所以提 PR 前打开
<https://awesome-dsh-plugin.com/plugins.json>，从 `categories` 里挑 1–2 个 id 抄进来。
邮件类插件最可能落在 `communication`（也可能是 `integration` 或 `productivity`），
但**不要照抄我的猜测**，要照抄目录里的 key。

运行期对条目的硬性要求只有两条（来自 `dshmarket` 的 `asRegistry`）：

1. 顶层 `plugins` 数组非空；
2. 每个条目的 `category` 至少有**一个非空字符串**。

其余字段缺失不会让目录被拒，但会少显示信息。

---

## 3. 预填好的条目

放进 `awesome-dsh-plugin` 仓库的插件列表里（一处条目）：

```json
{
  "name": "dsh-mail",
  "owner": "⟨你的 GitHub 用户名或组织⟩",
  "url": "https://github.com/⟨owner⟩/dsh-mail",
  "category": ["⟨从 plugins.json 的 categories 里抄一个 id⟩"],
  "description": {
    "en": "Let the agent send and receive email over plain IMAP/SMTP, with attachment upload and download. Works with QQ, 163, 126, Gmail, Outlook, iCloud, Yahoo, Zoho, Fastmail and any custom server; accounts and the authorization code are filled in on the plugin's settings page.",
    "zh": "让 agent 通过标准 IMAP/SMTP 收发邮件，支持附件上传与下载。适用 QQ / 163 / 126 / Gmail / Outlook / iCloud / Yahoo / Zoho / Fastmail 及任意自定义服务器；账号与授权码在插件设置页里填。"
  },
  "npm": "dsh-mail",
  "version": "0.1.0",
  "install": "dsh-mail",
  "added": "2026-10-20"
}
```

字段类型来自 `dshmarket/src/registry.ts` 的 `RegistryPlugin`：`name` / `owner` / `url` / `category` /
`description`（`Record<语言, 字符串>`）/ `install` / `added` 必填；`npm` / `tarball` / `version` / `stars` /
`downloads*` 可选。

两点如实说明：

- `install` 与 `npm` 我填成同样的包名。`install` 在 `dshmarket` 内部没有消费点（由客户端用它构造安装请求），
  也没有在本地代码里找到格式说明；npm 路线下它等于包名是最自然的取值。**提 PR 时对照一个已有的
  npm 条目确认一下**（目录里挑一个 `npm` 非空的条目，看它的 `install` 长什么样）。
- `stars` / `downloads*` 由 CI 每日刷新，**不要手填**。

---

## 4. 不要手填 `capabilities`

`capabilities` / `capabilityRedLines` / `capabilityCheckedAt` 是**静态扫描器对产物的报告**，不是作者声明。
类型定义本身说明了这一点：字段**缺失**表示「没能扫描」，而 `[]` 表示「扫过，未检出任何东西」——
两者在界面上的措辞不同（未扫描 vs 未检出），因为它们是完全不同的两句话。手填只会覆盖真实扫描结果。

扫描器用的词汇包括：`shell`、`network`、`credentials`、`fs-read`、`fs-write`、`env`、`llm`、`dynamic-code`。

dsh-mail 大概会被报出 `network`、`credentials`、`fs-read`、`fs-write`、`env`（不会有 `shell` 和 `llm`）。
建议在 PR 描述里**主动说明**这是插件的本分而不是可疑组合：

> 本插件必须持有邮箱凭据（授权码在插件内部存在不可枚举属性上，且以密文角色声明，
> 不会回显到浏览器界面），并必须连接你自己配置的 IMAP/SMTP 服务器 —— 这两件事就是它的全部功能。
> 它不执行 shell、不调用模型、不联网到除你配置的邮件服务器之外的任何地方。附件落盘路径会被限制在
> `attachmentDir` 之内（文件名净化 + 最终路径包含性校验）。

---

## 5. 提 PR

```bash
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
# 按仓库自己的 CONTRIBUTING/README 找到插件列表文件，加入上面那一条
git checkout -b add-dsh-mail
git commit -am "Add dsh-mail"
git push -u origin add-dsh-mail
```

然后在 GitHub 上开 PR。合并后站点与市场会自动收录，「usually within a day」。

**不要**向 `dsh-market/dsh-market` 提插件条目 —— 那是市场应用本身的仓库。

---

## 6. 发布前自查（与 README 的清单一致）

- [ ] `npm test` 全绿（191 项：39 + 18 + 35 + 22 + 15 + 32 + 13 + 17）
- [ ] `npm pack --dry-run` 含 `lib/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`README*.md`、`LICENSE`；**不含** `node_modules/`、`test/`、`docs/`
- [ ] `package.json` 的 `version` 已递增；`description` / `keywords` 齐全
- [ ] `locale/{en,zh}.json` 的 `meta.title` / `meta.description` 都写好了
- [ ] `icon.svg` 是你自己的原创素材（785 B，远低于内联 32 KiB 上限）
- [ ] `repository` / `homepage` 若要填，必须是真实可达的链接 —— **不要占位符**
- [ ] `engines.dsh` 满足（`>=0.2.0-rc.1 <0.3.0`，本机 0.2.1-rc.2 已验证满足）
- [ ] README 的服务商表与代码一致（`node test/print-tools.mjs` 核对）

**不需要**签名、校验和或来源证明 —— 三套机制里都没有这类字段。

---

## 7. 本地验证安装流程（可选）

想在上架**之前**把安装流程整个跑通，用 `DSHM_REGISTRY_URL` 指一份自建的目录 JSON
（这是三套机制里唯一有文档记载的本地覆盖钩子）：

```powershell
$env:DSHM_REGISTRY_URL = 'https://your-mirror.example/plugins.json'
```

或者用本仓库已经有了的、更彻底的安装验证 harness：
`_research/install-verification/README.md` —— 它在隔离的 `DSH_HOME` 里跑真实
`dsh plugin add` → `--dump-config` → 模块解析 → `apply()` → 工具注册 → 卸载回退。

---

## 8. 已验证 / 未验证 的边界

**已用真实代码验证：**

- 打包内容（`npm pack --dry-run`：15 文件，约 61 kB）
- `dsh.bundle.patch` 被找到并合成（`--dump-config` 输出里就是本插件的行与 config）
- 安装 → 模块解析 → `apply()` → 8 个工具注册 → 参数 schema 过宿主 `assertObjectJsonSchema` → 卸载回退（整套见 `_research/install-verification/`）
- 配置 schema 派生设置表单、密文摘除（6 个密文位置、`set` 标记正确、明文不进客户端方向）
- `engines.dsh` 与本机运行时的兼容性（`validate-manifest.mjs` 直接读 `app.asar`）
- **出站**：进程内真实 SMTP 服务器上跑完 EHLO/AUTH/MAIL/RCPT/DATA，收到的报文用同一个 mailparser 解回；附件字节逐个相等，`bcc` 只进信封不进信头，`requireTLS: false` 生效
- **入站**：进程内真实 IMAP 服务器上走完 `AUTHENTICATE PLAIN` → `LIST`/`LSUB`/`STATUS` → `SELECT` → `UID SEARCH` → `FETCH` → `UID STORE`/`UID MOVE`；列文件夹、列邮件、条件搜索（含非 ASCII 搜索词走字面量）、按 UID 读信、收件人与抄送、标记已读/星标、移动到垃圾箱、附件下载都有断言，且断言的是线协议上真实发生的事
- **入站落盘**：手工构造的 multipart 报文（RFC 2047 中文文件名 + `../../evil.txt`）能正确还原名字与字节，且目标目录之外没有任何文件被写出
- **回复**：同时起 IMAP 与 SMTP 两个服务器，验证「回复」只发给原发件人、「回复全部」才带原抄送人、`Re:` / `In-Reply-To` / `References` 真进了报文、`quote` 逐行引用原文，以及勾选保存副本时「已发送」里那份与真正发出的**字节相同**
- **账号界面**：`lib/client.js` 被真实执行（假 `__ModuleLoader__` + 桩 React），验证向 `sidebar.panellist` 与 `main` 注册、侧栏 id 与页面 key 一致、页面能渲染出表单、渲染树无授权码明文；JSON 接口用真实 HTTP 请求验过增删改、留空不改授权码、跨站 403；并断言页面存进去的账号 `mail_accounts` 立刻可见
- **真机可见**：重启后左侧栏出现「邮件」入口，主区页面正常渲染，保存后工具当场读到该账号，删除后回到空（已在当前安装的 DSH 上实测）

> 这些测试抓到过四个真缺陷并已修复：收件人/抄送曾全部变 `null`（连带「回复全部」静默丢光抄送人）；移动/删除曾在没选中邮箱时**一条命令都不发却返回成功**；勾选「保存发件副本」时曾**什么都没追加**（nodemailer 的 SMTP transport 不返回原始报文）。现在都是回归断言。

**未验证（需要你或线上环境）：**

- npm 包名 `dsh-mail` 是否可用（联网查）
- `category` 的合法 id（联网读 `plugins.json` 的 `categories`）
- `install` 字段在真实目录条目里的确切写法（对照一个已有的 npm 条目）
- **真实邮箱服务商**的行为（收发两条协议链路都已用进程内服务器验证，但 QQ/163 这些服务商特有的文件夹命名、限流、退信策略只能在真机上确认 —— 需要你的授权码）
- 设置页表单的**实际渲染效果**（需要有界面的浏览器，装好后人工确认）