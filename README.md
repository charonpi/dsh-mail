# dsh-mail

给 DeepSeek Harness（DSH）用的**多邮箱收发插件**：让 agent 直接读信、搜信、发信、回信，并且**上传附件与下载附件**。

支持 QQ / 腾讯企业邮 / 163 / 126 / yeah / 新浪 / 搜狐 / 139 / 189 / 阿里云企业邮 / Gmail / Outlook / iCloud / Yahoo / Zoho / Fastmail，也可以填任意自建 IMAP/SMTP 服务器 —— 走的是标准 IMAP/SMTP 协议，不是某个厂商的私有接口。

- 纯 Host 插件，安装即给 agent 增加 8 个 `mail_*` 工具，不需要额外服务进程。
- 附件是**一等公民**：`mail_send` 直接读本地文件作为附件发出，`mail_read` 可把附件落盘。
- 凭证永不进入模型可见的输出，也不会回显到设置界面（不可枚举字段 + 密文角色 + 单测断言）。
- 自带 191 项离线测试，`npm test` 即可跑，不需要任何邮箱账号。

---

## 目录

- [安装](#安装)
- [配置邮箱账号](#配置邮箱账号)
- [QQ 邮箱授权码怎么拿](#qq-邮箱授权码怎么拿)
- [各服务商预设](#各服务商预设)
- [工具参考](#工具参考)
- [用法示例](#用法示例)
- [附件上传与下载](#附件上传与下载)
- [安全说明](#安全说明)
- [故障排查](#故障排查)
- [开发](#开发)
- [发布到插件市场](#发布到插件市场)
- [许可](#许可)

---

## 安装

**先确认你用的是哪个 profile** —— 这一步搞错，装完什么都不会出现。

DSH 的 profile 是**互相独立**的：装在 `web` 里的插件，桌面端（`desktop`）看不到，反之亦然。

| 你平时怎么用 DSH | 该装进哪个 profile | 怎么装 |
|---|---|---|
| 桌面应用（`DSH NEXT.exe`，Electron） | `desktop` | **只能用图形界面**（命令行装不了，见下） |
| 命令行启动的网页版（`dsh web`） | `web` | 命令行或图形界面都行 |

### 桌面应用（Electron）用户

**命令行装 `desktop` 会被直接拒绝**，这是 DSH 的硬性设计：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以请走图形界面：打开左侧栏的 **插件** 页面 → 安装第三方插件 → 填包名
`github:charonpi/dsh-mail`（或本机目录的绝对路径）。

### 命令行 `dsh web` 用户

```bash
dsh plugin --profile web add github:charonpi/dsh-mail
```

本地开发时用 link（源码留在可写目录里，改完重启即可）：

```bash
cd /path/to/dsh-mail && npm install
dsh plugin --profile web add link:/absolute/path/to/dsh-mail
```

> `dsh plugin add` 会把这个包写进 profile 的 `dsh.profile.bundles` 并叠加插件的
> `cordis.patch.yml`。**不要手工编辑** profile 的 `package.json` 或 `cordis.patch.yml`。

> ⚠️ **npm 上的 `dsh-mail` 不是这个插件**。这个名字已被他人占用，本项目**没有**发布到
> npm，所以 `dsh plugin add dsh-mail` 会装到别的包。请一律用上面的 `github:` 形式。

安装之后**重启 DSH**，`mail_*` 工具才会出现（改账号配置本身不需要重启，见下）。

安装完可以先让 agent 调一次 `mail_accounts`，它会直接告诉你账号配好没有。

---

## 配置邮箱账号

### 推荐：左侧栏的「邮件」页面

装好之后，DSH **左侧栏会多出一项「邮件」**（在「插件市场」和「自动化任务」之间）。点开是主区里的一个独立页面：

1. 填**邮箱地址**（例如 `123456789@qq.com`）。
2. **服务商**可以留空，会按域名自动识别；也可以在下拉里选 qq / 163 / 126 / gmail / outlook 等。
3. 填**授权码**（不是登录密码）。
4. 点**保存**，立刻生效，**不需要重启**。

页面里还能看到已保存的账号、编辑（密码框留空 = 不修改已存的授权码）、删除。

**授权码永远不会被回显**：页面列出账号时，服务端只告诉它「已存 / 缺授权码」，
不会把明文发回浏览器；只有在你输入新值时才上行。

这个页面是 DSH 的**正式客户端插件**（`lib/client.js`）：向宿主注册 `sidebar.panellist`
一个入口、`main` 一个页面，不是往页面里塞脚本。所以它跟「插件」「Skill / MCP」那些入口是同一套东西。

账号存在一个独立文件里，**不动** DSH 的 `cordis.patch.yml`：

| 位置 | 说明 |
|---|---|
| `<DSH_PROFILE_DIR>/dsh-mail/accounts.json` | 有 profile 目录时（每个 profile 一份） |
| `~/.dsh/dsh-mail/accounts.json` | 没有 profile 目录时的兜底 |
| `$DSH_MAIL_DATA_DIR/accounts.json` | 自定义（测试时用这个） |

这个文件里的账号**优先于**配置文件里的同名账号 —— 你刚在页面上改过，就该以页面为准。
配置文件里独有的账号仍然会被列出（页面上单独标为「来自 cordis.patch.yml」）。

> **看不到那个入口？** 客户端插件是宿主启动时加载的，**改完插件代码必须重启一次 DSH**
> （设置面板右上角「重启」→「重启」；「重新加载界面」不够）。
> 实在没有就退回下面「直接写 config」，数据是同一份。

### 备选：在设置页里填

本插件还声明了配置 schema，DSH 会据此尝试**自动生成设置表单**。若你的版本里能看到
**插件 / 设置 → dsh-mail**，效果等价：在「账号」列表里加一项，填 `address` / `provider` /
`password` 即可。保存同样立即生效。

### 一个必须说清的取舍：授权码会明文落到配置文件里

表单里的值最终写进你 profile 的 `cordis.patch.yml`（插件配置就存在那里）。

`role('secret')` 保证的是**授权码不跨进程进入浏览器界面、不进日志**（插件内部对它有专门的脱敏处理与测试），**它不等于磁盘加密**。

如果你不想让明文留在配置文件里，把授权码放进**环境变量或文件**，然后在表单里填**变量名 / 文件名**（这三栏也在表单里）：

| 表单里填 | 实际存放位置 |
|---|---|
| `authCodeEnv: QQMAIL_AUTH_CODE` | 授权码在环境变量里，配置文件里只有变量名 |
| `passwordEnv: GMAIL_APP_PASSWORD` | 同上 |
| `passwordFile: D:/secrets/qq.txt` | 授权码在一个独立文件里（内容是明文，请自行收紧权限） |

设置环境变量（Windows，改完要重启 DSH 才能被读到）：

```powershell
[Environment]::SetEnvironmentVariable('QQMAIL_AUTH_CODE', '十六位授权码', 'User')
```

macOS / Linux（写入 shell 配置后重启 DSH）：

```bash
export QQMAIL_AUTH_CODE='十六位授权码'
```

### 也可以直接写 config

设置页读写的就是这一份数据，直接编辑等价：

```yaml
- insert:
    - id: dsh-mail
      name: dsh-mail
      config:
        defaultAccount: qq          # 多账号时必填；只有一个账号可省略
        attachmentDir: mail-attachments   # 附件默认落地目录（相对会话工作目录）
        maxBodyChars: 20000         # 单封正文回传给模型的最大字符数
        timeoutMs: 30000            # 连接/命令超时
        accounts:
          - id: qq
            label: QQ 邮箱
            provider: qq            # 见下方预设表
            address: 123456789@qq.com
            authCodeEnv: QQMAIL_AUTH_CODE
```

只要一个账号时，`provider` 都可以省 —— 会**按邮箱域名自动推断**：

```yaml
        accounts:
          - id: gmail
            address: you@gmail.com
            passwordEnv: GMAIL_APP_PASSWORD     # 自动推断出 imap.gmail.com / smtp.gmail.com
```

> 手写的 config 会被 schema 校验。校验刻意做得**很宽容**：字段类型写错（比如 `port: "993"`）、写了没用的多余字段、账号填了一半，都**不会**让插件加载失败 —— 只会在 `mail_accounts` 里报告具体哪一项缺什么。这样你永远不会遇到「插件装上了但工具不见了，还不知道为什么」。

### 授权码的解析顺序

在同一个账号里，插件按这个顺序取第一个有值的来源：

| 顺序 | 字段 | 说明 |
|---|---|---|
| 1 | `password` / `authCode` / `token` | 表单里直接填的值（明文存在配置文件里） |
| 2 | `passwordEnv` / `authCodeEnv` / `tokenEnv` | 从该环境变量读 |
| 3 | `passwordFile` | 从该文件读，取首尾空白后的内容 |
| 4 | *自动推导的环境变量* | 什么都没配时，找 `DSH_MAIL_<ID>_PASSWORD`（大写，非字母数字换成 `_`）。`id: qq` → `DSH_MAIL_QQ_PASSWORD` |

### 账号字段一览

| 字段 | 说明 |
|---|---|
| `id` | 账号标识，工具里用 `account` 参数引用它。留空会用邮箱地址自动生成。 |
| `address` / `email` | 完整邮箱地址，同时作为默认登录用户名。 |
| `provider` | 预设 id、别名或裸域名（如 `163.com`）。省略时按 `address` 的域名推断。 |
| `label` | 显示用的名字。 |
| `userName` / `user` | 登录用户名，默认等于 `address`（有些服务器要求不带 `@域名` 的短名）。 |
| `imap` / `smtp` | `{ host, port, secure, requireTLS? }`。写了就**完全覆盖**预设。 |
| `senderName` | 发信时的显示名。 |
| `replyTo` | 发信时固定带的 Reply-To。 |
| `signature` | 自动追加到纯文本正文末尾的签名（已包含则不重复追加）。 |
| `sentFolder` / `draftsFolder` / `trashFolder` | 手动指定这些特殊文件夹；默认按服务器的 SPECIAL-USE 标记自动识别，并回退到常见名字（`Sent`、`已发送`、`Sent Messages`…）。 |
| `appendToSent` | 发信后是否把副本追加进「已发送」。默认 `true`。 |

---

## QQ 邮箱授权码怎么拿

QQ 邮箱**不接受**你的 QQ 登录密码，必须用「授权码」。步骤：

1. 用浏览器登录 <https://mail.qq.com>。
2. 顶部点 **设置 → 账户**（新版可能在 **设置 → 账户 → POP3/IMAP/SMTP/…服务**）。
3. 找到 **IMAP/SMTP 服务**，点 **开启**。
4. 按提示用手机发送一条验证短信；验证通过后，页面会弹出一串 **16 位授权码**。
5. 复制它（**只显示一次**，关掉就看不到了；忘了就重新生成）。
6. 回到 DSH，打开 **插件 / 设置 → dsh-mail**，添加一个账号：
   - `address` 填 `你的QQ号@qq.com`
   - `provider` 留空即可（会按域名自动判断成 QQ 邮箱）
   - `password` 粘贴那 16 位授权码
7. 保存后让 agent 调 `mail_accounts` 确认状态是「可用」。**不需要重启。**

不想让授权码明文留在 profile 配置里的话，改成在第 6 步填 `authCodeEnv: QQMAIL_AUTH_CODE`，
并按[上一节](#一个必须说清的取舍授权码会明文落到配置文件里)设置同名环境变量（那种情况下需要重启 DSH 一次）。

QQ 的 IMAP 服务器有个已知的挑剔点：连接后如果客户端不发 `ID` 命令，会返回 `Unsafe Login`。本插件已经内置发送客户端标识，正常情况下不需要你处理。

> QQ 的企业邮（`exmail`）是另一套服务器，用 `provider: exmail`。

---

## 各服务商预设

`secure` 为 `true` 表示从第一个字节就走 TLS；`587` 那几行走明文连接后升级 STARTTLS。

| `provider` | 名称 | IMAP | SMTP | 密码字段里该填什么 |
|---|---|---|---|---|
| `qq` | QQ 邮箱 | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | 16 位授权码 |
| `exmail` | 腾讯企业邮 | `imap.exmail.qq.com:993` TLS | `smtp.exmail.qq.com:465` TLS | 登录密码或专用密码 |
| `163` | 网易 163 | `imap.163.com:993` TLS | `smtp.163.com:465` TLS | 授权码 |
| `126` | 网易 126 | `imap.126.com:993` TLS | `smtp.126.com:465` TLS | 授权码 |
| `yeah` | 网易 yeah.net | `imap.yeah.net:993` TLS | `smtp.yeah.net:465` TLS | 授权码 |
| `sina` | 新浪邮箱 | `imap.sina.com:993` TLS | `smtp.sina.com:465` TLS | 授权码 |
| `sohu` | 搜狐邮箱 | `imap.sohu.com:993` TLS | `smtp.sohu.com:465` TLS | 登录密码或独立密码 |
| `139` | 中国移动 139 | `imap.139.com:993` TLS | `smtp.139.com:465` TLS | 通常为登录密码 |
| `189` | 中国电信 189 | `imap.189.cn:993` TLS | `smtp.189.cn:465` TLS | 通常为登录密码 |
| `aliyun` | 阿里云企业邮 | `imap.qiye.aliyun.com:993` TLS | `smtp.qiye.aliyun.com:465` TLS | 邮箱密码 |
| `gmail` | Gmail | `imap.gmail.com:993` TLS | `smtp.gmail.com:465` TLS | **应用专用密码**（需先开两步验证） |
| `outlook` | Outlook / Microsoft 365 | `outlook.office365.com:993` TLS | `smtp.office365.com:587` STARTTLS | 应用密码；**多数账号已停用基础认证，需要 OAuth2** |
| `icloud` | iCloud 邮箱 | `imap.mail.me.com:993` TLS | `smtp.mail.me.com:587` STARTTLS | App 专用密码 |
| `yahoo` | Yahoo Mail | `imap.mail.yahoo.com:993` TLS | `smtp.mail.yahoo.com:465` TLS | App password |
| `zoho` | Zoho Mail | `imap.zoho.com:993` TLS | `smtp.zoho.com:465` TLS | App password（跨数据中心要自己填 `imap/smtp`） |
| `fastmail` | Fastmail | `imap.fastmail.com:993` TLS | `smtp.fastmail.com:465` TLS | App password |

**预设只是便利，不是限制。** 任何预设之外的邮箱，直接写 `imap` 与 `smtp` 即可：

```yaml
        accounts:
          - id: work
            address: me@example.com
            passwordEnv: WORK_MAIL_PASSWORD
            imap: { host: imap.example.com, port: 993, secure: true }
            smtp: { host: smtp.example.com, port: 465, secure: true }
```

---

## 工具参考

安装后 agent 会多出下面 8 个工具。

### `mail_accounts`

列出 dsh-mail 配置的邮箱账号及其可用状态（服务器、认证方式、是否已提供授权码）。收发邮件前先用它确认账号 id；如果返回「不可用」，按提示补配置而不是反复重试。

无参数。

### `mail_folders`

列出某个邮箱账号的 IMAP 文件夹（收件箱、已发送、草稿、垃圾箱等），含邮件数与未读数。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `account` | string | 可选 | 账号 id（见 mail_accounts）。多账号时必填，单账号可省略。 |

### `mail_list`

列出某文件夹里最新的邮件（默认收件箱，最新在前），可按未读、时间范围、发件人、主题、正文关键词过滤。返回每封的 uid、发件人、主题、时间、是否有附件；读正文再用 mail_read。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `account` | string | 可选 | 账号 id。多账号时必填。 |
| `folder` | string | 可选 | 文件夹路径，默认 `INBOX`。 |
| `limit` | integer | 可选 | 返回条数上限，默认 20，最大 200。 |
| `unreadOnly` | boolean | 可选 | 只要未读邮件。 |
| `since` | string | 可选 | 只看该日期之后（含）的邮件，如 `2026-10-01`。 |
| `before` | string | 可选 | 只看该日期之前的邮件。 |
| `from` | string | 可选 | 按发件人过滤。 |
| `to` | string | 可选 | 按收件人过滤。 |
| `subject` | string | 可选 | 按主题过滤。 |
| `text` | string | 可选 | 全文搜索（含正文）。 |
| `body` | string | 可选 | 只搜正文。 |

### `mail_search`

在邮箱里搜索邮件（发件人 / 主题 / 正文关键词 / 时间范围 / 未读）。至少要给一个条件；只是想看最新邮件请用 `mail_list`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `account` | string | 可选 | 账号 id。 |
| `folder` | string | 可选 | 文件夹路径，默认 `INBOX`。 |
| `from` | string | 可选 | 发件人关键词，如 `bristol.ac.uk`。 |
| `to` | string | 可选 | 收件人关键词。 |
| `subject` | string | 可选 | 主题关键词。 |
| `text` | string | 可选 | 全文关键词。 |
| `body` | string | 可选 | 仅正文关键词。 |
| `since` | string | 可选 | 起始日期。 |
| `before` | string | 可选 | 截止日期（不含）。 |
| `unreadOnly` | boolean | 可选 | 只要未读。 |
| `limit` | integer | 可选 | 返回条数上限，默认 25，最大 200。 |

### `mail_read`

按 uid 读取一封邮件的完整内容：主题、收发件人、时间、纯文本正文，以及附件清单。默认**不会**把邮件标记为已读。用 `saveAttachmentsTo` 可以把附件保存到本地（即下载附件）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uid` | integer | **必填** | 邮件 UID，来自 `mail_list` / `mail_search` 的结果。 |
| `account` | string | 可选 | 账号 id。 |
| `folder` | string | 可选 | 文件夹路径，默认 `INBOX`。 |
| `includeHtml` | boolean | 可选 | 同时返回 HTML 正文。默认只返回纯文本。 |
| `markSeen` | boolean | 可选 | 置为已读。默认 `false`，不改变邮箱状态。 |
| `saveAttachmentsTo` | string | 可选 | 把附件保存到此目录并返回文件路径（绝对路径或相对会话工作目录）。 |
| `attachmentIndexes` | array\<integer\> | 可选 | 只保存指定序号的附件。不传则全部保存。 |

### `mail_send`

通过 SMTP 发送一封新邮件。`attachments` 传本地文件路径数组 —— **这就是「上传附件」**。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | **必填** | 收件人，多个用逗号或分号分隔。 |
| `subject` | string | **必填** | 主题。 |
| `text` | string | 可选 | 纯文本正文。与 `html` 至少给一个。 |
| `html` | string | 可选 | HTML 正文。 |
| `cc` | string | 可选 | 抄送。 |
| `bcc` | string | 可选 | 密送。 |
| `attachments` | array\<string\> | 可选 | 附件文件路径数组（绝对路径，或相对会话工作目录）。 |
| `account` | string | 可选 | 账号 id。 |
| `replyTo` | string | 可选 | 覆盖 Reply-To。 |
| `senderName` | string | 可选 | 覆盖发件人显示名。 |
| `appendToSent` | boolean | 可选 | 是否追加发件副本到「已发送」，默认按账号配置。 |

### `mail_reply`

回复某封邮件，自动带上 `Re:` 主题、`In-Reply-To` 与 `References`，保证在收件人那边落在同一个会话里。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uid` | integer | **必填** | 原邮件 UID。 |
| `text` | string | 可选 | 回复正文（纯文本）。与 `html` 至少给一个。 |
| `html` | string | 可选 | 回复正文（HTML）。 |
| `all` | boolean | 可选 | 回复全部。默认只回复发件人；开启后会把原收件人加入抄送，并**自动排除你自己**。 |
| `quote` | boolean | 可选 | 在正文末尾附上原文（`>` 引用）。默认 `false`。 |
| `attachments` | array\<string\> | 可选 | 附件文件路径数组。 |
| `account` | string | 可选 | 账号 id。 |
| `folder` | string | 可选 | 原邮件所在文件夹，默认 `INBOX`。 |

### `mail_update`

改变邮件状态或位置。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | **必填** | `markRead` 标为已读 · `markUnread` 标为未读 · `flag` 加星标 · `unflag` 取消星标 · `move` 移到 `to` · `delete` 移到垃圾箱（**可逆**） |
| `uid` | integer | 可选 | 单个 UID。 |
| `uids` | array\<integer\> | 可选 | 多个 UID。 |
| `to` | string | 可选 | `action=move` 的目标文件夹。 |
| `folder` | string | 可选 | 来源文件夹，默认 `INBOX`。 |
| `account` | string | 可选 | 账号 id。 |

---

## 用法示例

配好之后，直接用自然语言指挥 agent 即可。下面是背后实际发生的工具调用：

**看未读**

```json
{ "tool": "mail_list", "args": { "unreadOnly": true, "limit": 10 } }
```

**搜某学校的来信**

```json
{ "tool": "mail_search", "args": { "from": "bristol.ac.uk", "since": "2026-09-01" } }
```

**读一封并标记已读**

```json
{ "tool": "mail_read", "args": { "uid": 12345, "markSeen": true } }
```

**发一封带两封附件的邮件**

```json
{
  "tool": "mail_send",
  "args": {
    "to": "kai.zhang@bristol.ac.uk",
    "subject": "PhD Application - Zizheng Wang",
    "text": "Dear Dr. Zhang,\n\nPlease find my application materials attached.\n\nBest regards,\nZizheng",
    "attachments": ["申请材料/CV.pdf", "申请材料/成绩单.pdf"]
  }
}
```

**回复并带上原文**

```json
{ "tool": "mail_reply", "args": { "uid": 12345, "text": "谢谢，我下周提交。", "quote": true } }
```

---

## 附件上传与下载

**上传（发信带附件）**：给 `mail_send` / `mail_reply` 的 `attachments` 数组填本地文件路径。

- 绝对路径可以直接用；相对路径按**当前会话的工作目录**解析。
- 文件不存在或不是普通文件时，会在发信前就报错，不会发出去半封邮件。
- 中文等非 ASCII 文件名会按 RFC 2231 正确编码，收件人那边显示正常。

**下载（收信取附件）**：`mail_read` 加 `saveAttachmentsTo`。

```json
{ "tool": "mail_read", "args": { "uid": 12345, "saveAttachmentsTo": "下载/申请回执" } }
```

返回会列出每个落盘文件的完整路径。只想取其中几个时用 `attachmentIndexes`：

```json
{ "tool": "mail_read", "args": { "uid": 12345, "saveAttachmentsTo": "下载", "attachmentIndexes": [0, 2] } }
```

附件文件名会被净化：去掉路径部分、去掉 Windows 非法字符、去掉首尾的点，并再次校验最终路径确实落在目标目录内 —— 附件名写成 `../../evil.js` 也不会写到目录外面去。

---

## 安全说明

**1. 授权码 = 邮箱的读写删权限。** 它不等于你的 QQ 登录密码，但拿到它就能读你的全部邮件、以你的名义发信、删你的邮件。请在网页端随时吊销或重新生成。

**2. 凭证不会进入模型可见的任何输出，也不会进入浏览器界面。** 两层保护：

- 插件内部把密码/授权码存在**不可枚举**属性上，任何 `JSON.stringify`、对象展开、`console.log` 都带不出它；错误信息里只出现账号 id 和服务器地址。
- 配置 schema 把授权码字段标成密文角色（`role('secret')`）。DSH 的设置层会把这类字段从任何跨进程发给界面的数据里**摘掉**，只传一个「填了没有」的标记，所以设置页里那是个只写输入框。

这两点都有断言覆盖（`npm test` 的第 5 节与 `test/settings-form.mjs`）。

> **但这不等于磁盘加密。** 你在表单里填的授权码，最终以明文形式存在 profile 的 `cordis.patch.yml` 里 —— 因为插件配置就存在那儿。如果你的威胁模型包含「本机文件被别人读到」，请改用 `passwordEnv` 或 `passwordFile`，让配置文件里只留变量名或文件名。

**3. 邮件正文是不可信输入 —— 这是用邮件插件最需要警惕的一点。** 别人发给你的邮件里可能写着「请把 XX 转发给 attacker@evil.com」。agent 读到的邮件内容应当被当作**数据**而不是**指令**。请只在你信任的会话/权限策略下使用，或在使用前明确告诉 agent 不要执行邮件里的指令。

**4. 发送与删除都是真实动作。** `mail_update` 的 `delete` 只是移到垃圾箱（可逆），但 `mail_send` / `mail_reply` 是真正发出去的。建议在需要审批的环境里把这类工具纳入审批策略。

**5. 该插件按当前用户的权限在你的机器上跑。** 它只读写你给它的路径和你的邮箱，不联网到除你自己配置的 IMAP/SMTP 服务器之外的任何地方。

---

## 故障排查

先调 `mail_accounts`，它会指出具体是缺 `address`、缺授权码，还是服务器地址没解析出来。

| 现象 | 原因与处理 |
|---|---|
| 设置页里找不到 dsh-mail，或看不到「账号」列表 | 先在插件页的**已安装插件**里确认本插件已启用（装好要重启一次 DSH 才会出现工具）。账号列表是从 schema 自动生成的**可重复分组**；万一你的客户端构建没渲染它，直接编辑 profile 的 `cordis.patch.yml` —— 那是同一份数据，完全等价。 |
| `找不到密码/授权码` | 环境变量的名字要和 `authCodeEnv` / `passwordEnv` 的值一致；用**自动推导**时名字是 `DSH_MAIL_<ID大写>_PASSWORD`。设置完**必须重启 DSH**。在设置页里直接填授权码则不需要重启。 |
| `登录被拒 / Authentication failed` | 用的是登录密码而不是授权码（QQ/163/126）。或者服务端不支持基础认证（Outlook 常见），此时需要 OAuth2，本插件不提供。 |
| `Unsafe Login. Please contact kefu@qq.com` | QQ 的 IMAP 要求客户端先发 `ID` 命令。本插件已内置发送；若仍出现，请在配置里显式写 `imap`/`smtp` 并确认没被其他字段覆盖。 |
| `无法连接` / 超时 | 网络或防火墙挡了 993/465/587。Gmail 在大陆网络环境下通常需要代理。 |
| 自签名证书报 TLS 错 | 默认校验证书。自建服务器请先把证书弄成受信任的，不要为了绕过而在生产里关校验。 |
| 发信成功但「已发送」里没有 | 服务器没暴露 SPECIAL-USE 标记，或文件夹名不常见。用 `mail_folders` 看真实路径，然后写进账号的 `sentFolder`。 |
| 附件发出去是空的 | 检查 `attachments` 里给的是文件路径而不是目录。相对路径是按会话工作目录解析的，必要时写绝对路径。 |
| 正文太长被截断 | 调大 `maxBodyChars`（默认 20000 字符）。这是为了防止一封长邮件撑爆上下文。 |

---

## 开发

```
dsh-mail/
├── package.json           # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml       # 安装时叠加的挂载声明 + 账号配置示例
├── icon.svg               # 插件图标（原创）
├── locale/{en,zh}.json    # 插件在界面里的标题与描述
├── lib/
│   ├── index.js           # Host 插件：Config schema（设置页表单来源）+ 注册 8 个 mail_* 工具
│   ├── mail.js            # 邮件引擎：IMAP 读写、SMTP 发信、附件、回复头
│   ├── config.js          # 配置归一化、活引用解包、凭证解析、账号选择
│   ├── providers.js       # 16 家服务商预设 + 域名推断
│   ├── client.js          # 客户端插件：左侧栏「邮件」入口 + 主区账号页面（React，无 JSX）
│   ├── setup-routes.js    # 页面用的 JSON 接口 + 诊断路由 + 跨站防护
│   └── accounts-file.js   # 账号持久化（独立 JSON，不动 cordis.patch.yml）
├── test/
│   ├── smoke.mjs             # 39 项：工具注册、参数校验、配置、凭证、附件、MIME、回复头、文件名净化
│   ├── settings-form.mjs     # 18 项：设置表单契约（volatile / secret / 宽容性 / 免重启）
│   ├── setup-ui.mjs          # 35 项：客户端 bundle（槽位注册、页面渲染）+ JSON 接口 + 账号文件 + 跨站防护
│   ├── smtp-send.mjs         # 22 项：进程内真实 SMTP 服务器 + 附件字节回解（出站链路）
│   ├── imap-receive.mjs      # 32 项：进程内真实 IMAP 服务器（收信链路：列/读/搜/标记/移动）
│   ├── reply-and-append.mjs  # 13 项：回复链路（IMAP 读原信 + SMTP 发出 + 追加发件副本）
│   ├── fake-imap.mjs         # 上面两条用的假 IMAP 服务器（测试辅助，不是测试本身）
│   ├── fake-smtp.mjs         # 假 SMTP 服务器（测试辅助，不是测试本身）
│   ├── attachments.mjs       # 15 项：真实 MIME → 落盘，含中文文件名与目录穿越防护
│   ├── validate-manifest.mjs # 17 项：清单自检（bundle 声明、client 导出、files 覆盖、图标、engines.dsh）
│   └── print-tools.mjs       # 导出工具参数表，用来核对文档没写偏

docs/marketplace-listing.md   # 上架清单（不进 npm 包）：目录条目、PR 步骤、能力披露
```

```bash
npm install     # 装依赖
npm test        # 191 项离线测试，全部不需要邮箱账号或网络
node test/print-tools.mjs   # 打印工具参数表
```

测试**不需要任何邮箱账号或网络**，四条链路各有专门覆盖：

- **出站**（`test/smtp-send.mjs`）在进程内起一个**真实的 SMTP 服务器**，让 nodemailer 走完 EHLO / AUTH / MAIL / RCPT / DATA，再把收到的原始报文用插件读信时用的**同一个 mailparser** 解回来。于是以下都成了可断言的事实：附件字节逐个相等（含非 ASCII 文件名与二进制内容）、`bcc` 必须出现在信封而绝不能出现在信头、`requireTLS: false` 真的不要求 STARTTLS、认证确实带了账号与授权码。
- **入站**（`test/imap-receive.mjs`）在进程内起一个**真实的 IMAP 服务器**，走完整协议（`AUTHENTICATE PLAIN` → `LIST`/`LSUB`/`STATUS` → `SELECT` → `UID SEARCH` → `FETCH` → `UID STORE`/`UID MOVE`），因此列文件夹、列邮件、条件搜索、按 UID 读信、标记已读/星标、移动到垃圾箱、附件下载全部有断言，且断言的是**线协议上真正发生了什么**（例如「移动必须发出 `UID MOVE`，而不是静默什么都不做」）。
- **回复**（`test/reply-and-append.mjs`）同时起上面两个服务器：从 IMAP 读原信、经 SMTP 发出去，验证「回复」只发给原发件人、「回复全部」才带上原抄送人、`Re:` / `In-Reply-To` / `References` 真的进了报文、`quote` 会逐行引用原文，以及勾选保存副本时**「已发送」里那份与真正发出的字节是同一份**。
- **入站落盘**（`test/attachments.mjs`）喂进去一封手工构造的 multipart 报文（含 RFC 2047 编码的中文文件名，以及一个名为 `../../evil.txt` 的附件），验证文件名还原、字节一致，以及**目标目录之外什么都没有被写出来**。
- **账号界面**（`test/setup-ui.mjs`）用假的 `__ModuleLoader__` + 桩 React **真的把 `lib/client.js` 跑一遍**：验证它导出的 `apply` 往 `sidebar.panellist` 与 `main` 两个槽位注册、侧栏行的 `id` 与主区页面的 `key` 一致（不一致宿主会直接抛）、页面组件能渲染出标题与表单、渲染树里没有授权码明文；再对 JSON 接口发**真实 HTTP 请求**验证增删改、留空不改授权码、跨站 403，并断言「页面上存的账号，`mail_accounts` 立刻列得出来」。

> 这些测试不是「写了就算」的装饰：它们已经抓到并修掉了四个真缺陷 —— 收件人/抄送曾经全部变成 `null`（连带「回复全部」静默丢光抄送人）；移动/删除曾经在没选中邮箱时**一条命令都不发却返回成功**；勾选「保存发件副本」时曾经**什么都没追加**（nodemailer 的 SMTP transport 不返回原始报文，原来那段代码等于空转）。现在它们都是回归断言。

设置表单那部分用的是**真实的宿主校验器**：`test/settings-form.mjs` 会构造真的活引用（cosmokit 的 `createVolatile`），验证改配置后下一次调用就生效；`validate-manifest.mjs` 会直接打开 `app.asar` 读出本机 DSH 版本，比对 `engines.dsh` 是否满足。

真正没有覆盖的两件事：**真实邮箱服务商的行为**（需要你的授权码 —— 收发两条协议链路都已用进程内服务器验证，但 QQ/163 这些服务商特有的文件夹命名、限流、退信策略只能在真机上确认），以及**设置页表单的实际渲染效果**（需要有界面的浏览器，只能在装好后人工确认）。

---

## 发布到插件市场

让它成为可安装插件的最小条件已经满足：`package.json` 声明了 `dsh.bundle.patch`，指向包内真实存在的 `cordis.patch.yml`，并且所有运行期文件都在 `files` 里。

值得知道的是，DSH 里其实有**三套互不相干的市场机制**，投稿路线完全不同：

| # | 机制 | 怎么上架 |
|---|---|---|
| 1 | **format-1 市场索引**（`market-index.json`） | **没有官方索引可投。** 需要你自己托管一个 `market-index.json`，再让用户手动添加索引源。索引源必须是 `http(s)://`，`file://` 会被拒绝，本地测试要用本地 HTTP 服务（如 `http://127.0.0.1:8765/market-index.json`）。 |
| 2 | **DSH Community Market** | 发布一个符合 provider 契约的**目录源**（静态 manifest + 一个 `/v1/plugins` 端点），任何用户都可以登记它，不需要官方审批。 |
| 3 | **`dshmarket`** | 这是**本机 desktop profile 正在启用的那个市场**。它的目录来自第三方精选仓库 `awesome-dsh-plugin` —— 上架方式是**向 `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提一个 PR**（加一条目录项），站点和市场会自动收录。 |

所以最现实的一条路是 **#3**：把包发到 npm，然后去 `awesome-dsh-plugin` 仓库提 PR。

另外几条已核实的规则，避免走弯路：

- **你本机实际启用的是 `dshmarket`**，发布方式是**向 `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提一个条目 PR**（不是往市场应用仓库提）。完整条目、PR 步骤、npm 发布流程见 [docs/marketplace-listing.md](docs/marketplace-listing.md)。
- **不需要签名、校验和或来源证明**，三套机制都没有这类字段。
- 安装器**会校验** `engines.dsh`（或 `@deepseek-ai/dsh*` 的 peer 依赖）。本包声明了 `engines.dsh: ">=0.2.0-rc.1 <0.3.0"`。
- 包的 `package.json` 必须声明 `dsh.bundle`，否则安装会被以 `not-bundle` 拒绝。
- 图标要么是 `https:` 或**与索引同源**的 URL，要么是内联 `data:`（SVG/PNG/JPEG/WebP，解码后 ≤ 32 KiB）。
- 本地端到端验证安装流程可以用环境变量 `DSHM_REGISTRY_URL` 指向一份自建的目录 JSON；本仓库另有一套更彻底的安装验证 harness，见 [`_research/install-verification/README.md`](../_research/install-verification/README.md)。

发布前自查清单：

- [ ] `npm pack --dry-run` 输出里包含 `lib/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`README*.md`、`LICENSE`，且**不**包含 `node_modules/`、`test/`、`docs/`。
- [ ] `package.json` 里 `version`、`description`、`keywords`（`dsh`、`dsh-plugin`、`deepseek-harness`）齐全。
- [ ] `locale/en.json` 与 `locale/zh.json` 的 `meta.title` / `meta.description` 都写好了。
- [ ] 图标是你自己的原创或许可允许的素材。
- [ ] `npm test` 全绿（191 项）。
- [ ] README 里的服务商说明与实际预设一致（`node test/print-tools.mjs` 核对）。
- [ ] 若填了 `repository` / `homepage`，链接真实可达（**不要填占位符**）。

关于「要不要自带界面」：本插件**不需要** `dsh.client` 或自建页面。它只声明 Host 端的 `Config`，
DSH 就会在插件设置页里为它生成表单（可编辑字段用 `.volatile()` 标出，授权码用 `role('secret')` 脱敏）。
只有当你要做 schema 表达不了的交互（比如「一键测连通性」按钮）时，才需要额外注册客户端模块 ——
那是后续可以加的东西，不是上架前提。

---

## 许可

MIT，见 [LICENSE](./LICENSE)。