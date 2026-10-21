# dsh-mail

A **multi-provider mail plugin for DeepSeek Harness (DSH)**: let the agent read, search, send and reply to email — **with attachment upload and download**.

Works with QQ, Tencent Exmail, 163, 126, yeah.net, Sina, Sohu, 139, 189, Aliyun Exmail, Gmail, Outlook, iCloud, Yahoo, Zoho and Fastmail, plus any custom IMAP/SMTP server. It speaks plain IMAP/SMTP, so it is not tied to one vendor's private API.

- A pure Host plugin: installing it adds eight `mail_*` tools to the agent. No extra service process.
- Attachments are first-class: `mail_send` reads local files and sends them; `mail_read` writes them to disk.
- Credentials never reach model-visible output (non-enumerable fields, asserted by tests).
- 191 offline tests, runnable with `npm test` and needing no mailbox at all.

---

## Install

```bash
# from npm (once published)
dsh plugin --profile desktop add dsh-mail

# from a local directory (development)
cd /path/to/dsh-mail && npm install
dsh plugin --profile desktop add link:/absolute/path/to/dsh-mail
```

`dsh plugin add` records the package in the profile's `dsh.profile.bundles` and applies the plugin's own `cordis.patch.yml`. **Do not hand-edit** the profile's `package.json` or `cordis.patch.yml`.

**Restart DSH after installing** so the `mail_*` tools appear. Changing configuration does *not* need a restart (see below). Then call `mail_accounts` to confirm your accounts are usable. If you set an environment variable, that needs a restart too.

---

## Configure an account

### Recommended: the "Mail" page in the sidebar

After installing, DSH gains a **"Mail" entry in the left sidebar** (between "Plugin market" and "Automation"). It opens a dedicated page in the main area:

1. Enter your **email address** (e.g. `123456789@qq.com`).
2. **Provider** may stay empty — it is inferred from the domain; or pick qq / 163 / 126 / gmail / outlook from the list.
3. Enter the **authorization code** (not your login password).
4. Press **Save**. It takes effect immediately, **no restart needed**.

The page also lists saved accounts and supports editing (leave the password box empty to keep the stored code) and deleting.

**The authorization code is never echoed back**: when listing accounts the server only reports "saved / missing", never the value; it only travels upward when you type a new one.

That page is a **proper DSH client plugin** (`lib/client.js`): it registers one `sidebar.panellist` row and one `main` page — the same mechanism the built-in "Plugins" and "Skill / MCP" entries use, not a script injected into the DOM.

Accounts live in a separate file; the plugin **never touches** `cordis.patch.yml`:

| Location | When |
|---|---|
| `<DSH_PROFILE_DIR>/dsh-mail/accounts.json` | when a profile dir exists (one per profile) |
| `~/.dsh/dsh-mail/accounts.json` | fallback when it does not |
| `$DSH_MAIL_DATA_DIR/accounts.json` | override (used by the tests) |

Accounts in that file **win over** same-id accounts in the config — your most recent edit came from the page. Config-only accounts are still listed (marked "from cordis.patch.yml").

> **No sidebar entry?** Client plugins load at host startup, so **restart DSH once** after
> changing plugin code (Settings → "重启" → "重启"; "reload UI" is not enough).
> Failing that, fall back to writing the config directly — same data.

### A tradeoff you should know about: the code is stored in plaintext

Whatever you type in the form is persisted into your profile's `cordis.patch.yml`, because that is where plugin
configuration lives.

`role('secret')` guarantees the code **never crosses the process boundary into the browser UI and never reaches a
log** (the plugin also keeps it on non-enumerable fields, and tests assert both). It is **not** disk encryption.

If you would rather not keep plaintext in the config file, put the code in an environment variable or a file and
type only the **name** into the form (those fields are in the form too):

| What you put in the form | Where the code actually lives |
|---|---|
| `authCodeEnv: QQMAIL_AUTH_CODE` | In an environment variable; config holds only the name |
| `passwordEnv: GMAIL_APP_PASSWORD` | Same |
| `passwordFile: D:/secrets/qq.txt` | In a separate file (plaintext — tighten its ACL) |

Setting a persistent environment variable on Windows (restart DSH afterwards so it is visible):

```powershell
[Environment]::SetEnvironmentVariable('QQMAIL_AUTH_CODE', 'your 16-character code', 'User')
```

### Or write the config directly

The settings page reads and writes exactly this data, so editing it by hand is equivalent:

```yaml
- insert:
    - id: dsh-mail
      name: dsh-mail
      config:
        defaultAccount: qq                # required when you have more than one account
        attachmentDir: mail-attachments   # where downloaded attachments land
        maxBodyChars: 20000               # body characters returned to the model per message
        timeoutMs: 30000
        accounts:
          - id: qq
            label: QQ Mail
            provider: qq                  # see the preset table below
            address: 123456789@qq.com
            authCodeEnv: QQMAIL_AUTH_CODE # read the secret from this env var
```

With a single account you can omit `provider` entirely — it is **inferred from the address domain**:

```yaml
        accounts:
          - id: gmail
            address: you@gmail.com
            passwordEnv: GMAIL_APP_PASSWORD   # resolves imap.gmail.com / smtp.gmail.com for you
```

> A hand-written config is validated against the schema, and that schema is deliberately **permissive**: a
> wrong scalar type (`port: "993"`), unknown extra fields, or a half-filled account will **not** stop the plugin
> from loading. Instead `mail_accounts` reports exactly what each account is missing — so you can never end up
> with a plugin that installed but silently has no tools.

### Secret resolution order

Within one account, the first source that has a value wins:

| Order | Field | Notes |
|---|---|---|
| 1 | `password` / `authCode` / `token` | The value typed into the form (plaintext in the config file) |
| 2 | `passwordEnv` / `authCodeEnv` / `tokenEnv` | Read from that environment variable |
| 3 | `passwordFile` | Read from that file, trimmed |
| 4 | *derived env var* | With nothing configured, `DSH_MAIL_<ID>_PASSWORD` (uppercased; non-alphanumerics become `_`). `id: qq` → `DSH_MAIL_QQ_PASSWORD`. |

### Account fields

| Field | Meaning |
|---|---|
| `id` | Account handle used by the tools' `account` argument. Derived from the address when omitted. |
| `address` / `email` | Full email address; also the default login user. |
| `provider` | Preset id, alias or bare domain (`163.com`). Inferred from `address` when omitted. |
| `label` | Human-readable name. |
| `userName` / `user` | Login user, defaults to `address` (some servers want the short name without the domain). |
| `imap` / `smtp` | `{ host, port, secure, requireTLS? }`. Anything you write **fully overrides** the preset. |
| `senderName` | Display name used when sending. |
| `replyTo` | Fixed Reply-To header when sending. |
| `signature` | Appended to the plain-text body once (skipped if already present). |
| `sentFolder` / `draftsFolder` / `trashFolder` | Override special folders. By default they are detected from the server's SPECIAL-USE flags, falling back to common names. |
| `appendToSent` | Append a copy to Sent after sending. Defaults to `true`. |

---

## Getting a QQ Mail authorization code

QQ Mail **rejects your QQ login password**; you must use an authorization code.

1. Sign in at <https://mail.qq.com> in a browser.
2. Open **Settings → Account** (on the new UI: **Settings → Account → POP3/IMAP/SMTP/… services**).
3. Find **IMAP/SMTP service** and click **Enable**.
4. Verify by SMS as prompted; a **16-character authorization code** is then shown.
5. Copy it — **it is shown once**. If you lose it, generate a new one.
6. Back in DSH, open **Plugins / Settings → dsh-mail** and add an account:
   - `address` — `your-qq-number@qq.com`
   - `provider` — leave empty (the domain resolves to QQ Mail)
   - `password` — paste the 16-character authorization code
7. Save, then call `mail_accounts` and confirm the status is usable. **No restart needed.**

If you would rather not keep the code in plaintext in your profile config, put `authCodeEnv: QQMAIL_AUTH_CODE` in
step 6 instead and set that environment variable (which does require one DSH restart).

QQ's IMAP server has a known quirk: if a client does not send the `ID` command right after connecting, it answers `Unsafe Login`. This plugin sends a client identifier already.

---

## Provider presets

`secure: true` means TLS from the first byte; the `587` rows connect in plaintext and upgrade with STARTTLS.

| `provider` | Name | IMAP | SMTP | What the password must be |
|---|---|---|---|---|
| `qq` | QQ Mail | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | 16-character authorization code |
| `exmail` | Tencent Exmail | `imap.exmail.qq.com:993` TLS | `smtp.exmail.qq.com:465` TLS | Login or app-specific password |
| `163` | NetEase 163 | `imap.163.com:993` TLS | `smtp.163.com:465` TLS | Authorization code |
| `126` | NetEase 126 | `imap.126.com:993` TLS | `smtp.126.com:465` TLS | Authorization code |
| `yeah` | NetEase yeah.net | `imap.yeah.net:993` TLS | `smtp.yeah.net:465` TLS | Authorization code |
| `sina` | Sina Mail | `imap.sina.com:993` TLS | `smtp.sina.com:465` TLS | Authorization code |
| `sohu` | Sohu Mail | `imap.sohu.com:993` TLS | `smtp.sohu.com:465` TLS | Login or separate password |
| `139` | China Mobile 139 | `imap.139.com:993` TLS | `smtp.139.com:465` TLS | Usually the login password |
| `189` | China Telecom 189 | `imap.189.cn:993` TLS | `smtp.189.cn:465` TLS | Usually the login password |
| `aliyun` | Aliyun Exmail | `imap.qiye.aliyun.com:993` TLS | `smtp.qiye.aliyun.com:465` TLS | Mailbox password |
| `gmail` | Gmail | `imap.gmail.com:993` TLS | `smtp.gmail.com:465` TLS | **App password** (requires 2FA) |
| `outlook` | Outlook / Microsoft 365 | `outlook.office365.com:993` TLS | `smtp.office365.com:587` STARTTLS | App password; **basic auth is widely disabled — OAuth2 is often required** |
| `icloud` | iCloud Mail | `imap.mail.me.com:993` TLS | `smtp.mail.me.com:587` STARTTLS | App-specific password |
| `yahoo` | Yahoo Mail | `imap.mail.yahoo.com:993` TLS | `smtp.mail.yahoo.com:465` TLS | App password |
| `zoho` | Zoho Mail | `imap.zoho.com:993` TLS | `smtp.zoho.com:465` TLS | App password (write `imap`/`smtp` explicitly for other data centres) |
| `fastmail` | Fastmail | `imap.fastmail.com:993` TLS | `smtp.fastmail.com:465` TLS | App password |

**Presets are a convenience, not a constraint.** For anything else, write `imap` and `smtp` directly.

---

## Tools

| Tool | Purpose |
|---|---|
| `mail_accounts` | List configured accounts and whether each is usable. Call this first. |
| `mail_folders` | List IMAP folders with message and unread counts. |
| `mail_list` | List the newest messages in a folder (filters: `unreadOnly`, `since`, `before`, `from`, `to`, `subject`, `text`, `body`). |
| `mail_search` | Search mail by sender, subject, body keyword or date range. Requires at least one condition. |
| `mail_read` | Read one message by `uid`; `saveAttachmentsTo` downloads its attachments. Never marks read unless `markSeen: true`. |
| `mail_send` | Send a new message; `attachments` takes local file paths (**attachment upload**). |
| `mail_reply` | Reply with a proper `Re:` subject plus `In-Reply-To`/`References`; `all: true` replies to everyone and excludes you. |
| `mail_update` | `markRead` · `markUnread` · `flag` · `unflag` · `move` · `delete` (moves to Trash, reversible). |

Run `node test/print-tools.mjs` for the full parameter reference of every tool.

---

## Examples

```json
{ "tool": "mail_list", "args": { "unreadOnly": true, "limit": 10 } }
```

```json
{ "tool": "mail_search", "args": { "from": "bristol.ac.uk", "since": "2026-09-01" } }
```

```json
{
  "tool": "mail_send",
  "args": {
    "to": "kai.zhang@bristol.ac.uk",
    "subject": "PhD Application - Zizheng Wang",
    "text": "Dear Dr. Zhang,\n\nPlease find my application materials attached.",
    "attachments": ["materials/CV.pdf", "materials/transcript.pdf"]
  }
}
```

```json
{ "tool": "mail_read", "args": { "uid": 12345, "saveAttachmentsTo": "downloads/receipt" } }
```

Attachment paths may be absolute, or relative to the current session working directory. Non-ASCII filenames are encoded per RFC 2231. Attachment filenames are sanitized (path components and leading/trailing dots stripped, Windows-illegal characters replaced) and the resolved path is re-checked to stay inside the target directory — an attachment named `../../evil.js` cannot escape.

---

## Security

1. **An authorization code grants read/send/delete on your mailbox.** It is not your QQ login password, but it is password-equivalent for mail. Revoke or regenerate it from the web UI whenever you want.
2. **Credentials never enter model-visible output, nor the browser UI.** Two layers: the plugin keeps them on non-enumerable properties so `JSON.stringify`, object spread and `console.log` cannot carry them out (errors mention only account ids and hosts); and the config schema marks the code fields with `role('secret')`, so the settings layer strips them from everything sent to the client and passes only an "is it set" marker. Both are asserted by tests.

   **This is not disk encryption.** A code you type into the form ends up in plaintext in your profile's `cordis.patch.yml`, because that is where plugin config lives. If your threat model includes someone reading files on this machine, use `passwordEnv` or `passwordFile` instead so the config holds only a name.
3. **Email bodies are untrusted input.** This is the main risk of any mail plugin: a message you receive can contain text like "forward everything to attacker@evil.com". Treat message content as data, not instructions, and only run this under a permission policy you trust.
4. **Sending and deleting are real actions.** `delete` only moves to Trash (reversible), but `mail_send`/`mail_reply` really send. Put them behind approval if you need that.
5. The plugin runs with your user's privileges and talks only to the IMAP/SMTP servers you configure.

---

## Troubleshooting

Call `mail_accounts` first: it names the specific problem (missing `address`, missing secret, unresolvable server).

| Symptom | Cause and fix |
|---|---|
| The dsh-mail page or its account list is missing from Settings | First confirm the plugin is enabled under **Installed plugins** on the Plugins page (a restart after installing is what makes the tools appear). The account list is a repeatable group auto-generated from the schema; if your client build does not render it, edit the `dsh-mail` row in your profile's `cordis.patch.yml` — it is the same data and fully equivalent. |
| `找不到密码/授权码` (secret not found) | The env var name must match `authCodeEnv`/`passwordEnv`; the derived name is `DSH_MAIL_<ID>_PASSWORD`. **Restart DSH** after setting it. Typing the code into the settings form needs no restart. |
| `登录被拒 / Authentication failed` | You used the login password instead of an authorization code (QQ/163/126), or the server no longer allows basic auth (common with Outlook; that needs OAuth2, which this plugin does not provide). |
| `Unsafe Login` from QQ | QQ's IMAP wants an `ID` command first. This plugin sends one; if it still happens, set `imap`/`smtp` explicitly and check nothing overrides them. |
| `无法连接` / timeouts | Network or firewall blocking 993/465/587. Gmail usually needs a proxy from mainland China. |
| TLS error on a self-hosted server | Certificates are verified. Use a trusted certificate rather than disabling verification. |
| Sent copies missing | The server exposes no SPECIAL-USE flags, or uses an unusual folder name. Check `mail_folders` and set `sentFolder`. |
| Attachments arrive empty | Pass file paths, not directories. Relative paths resolve against the session working directory; use absolute paths if unsure. |
| Body truncated | Raise `maxBodyChars` (default 20000). It exists to keep one long email from flooding the context. |

---

## Development

```bash
npm install
npm test                    # 191 offline checks, no mailbox or network needed
node test/print-tools.mjs   # print the tool parameter reference
```

The tests need **no mailbox and no network**, and every direction has dedicated coverage:

- **Outbound** (`test/smtp-send.mjs`) starts a **real SMTP server** inside the process and lets nodemailer walk EHLO / AUTH / MAIL / RCPT / DATA; the raw message it receives is then decoded with the **same mailparser the plugin uses to read mail**. That turns these into assertable facts: attachment bytes match byte for byte (non-ASCII filenames and binary content included), `bcc` reaches the envelope but must never reach the headers, `requireTLS: false` really does not demand STARTTLS, and authentication really carries the account address and authorization code.
- **Inbound** (`test/imap-receive.mjs`) starts a **real IMAP server** inside the process and speaks the whole protocol (`AUTHENTICATE PLAIN` → `LIST`/`LSUB`/`STATUS` → `SELECT` → `UID SEARCH` → `FETCH` → `UID STORE`/`UID MOVE`), so listing folders, listing messages, conditional search, reading by UID, marking read/flagged, moving to Trash and downloading attachments are all asserted — and what is asserted is **what actually crossed the wire** (for instance, that a move really emits `UID MOVE` instead of silently doing nothing).
- **Reply** (`test/reply-and-append.mjs`) starts both servers at once: it reads the original over IMAP and sends over SMTP, checking that a plain reply goes to the original sender only, that reply-all is what brings in the original Cc, that `Re:` / `In-Reply-To` / `References` really reach the message, that `quote` cites the original line by line, and that the copy saved to Sent is **byte-identical to what was actually sent**.
- **Inbound, to disk** (`test/attachments.mjs`) feeds in a hand-built multipart message (an RFC 2047-encoded Chinese filename, plus an attachment named `../../evil.txt`) and checks the name is restored, the bytes match, and that **nothing whatsoever is written outside the target directory**.
- **The account page** (`test/setup-ui.mjs`) runs `lib/client.js` for real against a fake `__ModuleLoader__` and a stub React: it checks that `apply` registers exactly the `sidebar.panellist` and `main` slots, that the sidebar row's `id` matches the page's `key` (a mismatch makes the host throw), that the page component renders a heading and a form, and that no authorization code leaks into the render tree — then fires **real HTTP requests** at the API to check add/edit/delete, that leaving the password blank keeps the stored one, and that cross-site requests get a 403, and asserts an account saved on the page is **immediately visible to `mail_accounts`**.

> These are not decorative: they have already caught and driven fixes for four real defects. Recipients and Cc used to come back as `null` (which also made reply-all silently drop every Cc); move/delete used to **send no command at all yet report success** when no mailbox had been selected; and ticking "save a copy" used to **append nothing whatsoever** (nodemailer's SMTP transport never returns the raw message, so that branch was a no-op). All of them are regression assertions now.

The settings-form tests use the **real host machinery**: `test/settings-form.mjs` builds genuine live references with cosmokit's `createVolatile` and proves an edit takes effect on the next call, and `validate-manifest.mjs` opens `app.asar` to read the installed DSH version and check `engines.dsh` against it.

Not covered: a real provider's behaviour (needs your credentials — both protocol directions are verified against in-process servers, but provider-specific folder naming, rate limits and bounce policy can only be confirmed against the real thing), and the settings form's actual rendered appearance (needs a browser UI, so confirm it by eye after installing).

```
lib/index.js      Host plugin: the Config schema (form source) and the eight mail_* tools
lib/mail.js       Mail engine: IMAP reads, SMTP sends, attachments, reply headers
lib/config.js     Config normalization, live-reference unwrapping, secret resolution
lib/providers.js  16 provider presets plus domain inference
lib/client.js     Client plugin: the sidebar "Mail" row + the main-area accounts page (React, no JSX)
lib/setup-routes.js  JSON API the page talks to, plus diagnostic routes and the cross-site guard
lib/accounts-file.js Account persistence (its own JSON file; cordis.patch.yml is never touched)
test/smoke.mjs            39 checks: registration, args, config, secrets, attachments, MIME
test/settings-form.mjs    18 checks: volatile/secret contract, permissiveness, no-restart edits
test/setup-ui.mjs         35 checks: the client bundle (slot registration, page render) + JSON API + account file + cross-site guard
test/smtp-send.mjs        22 checks: real in-process SMTP, attachment bytes decoded back
test/imap-receive.mjs     32 checks: real in-process IMAP (folders, list, search, read, flags, move)
test/reply-and-append.mjs 13 checks: reply path (IMAP read + SMTP send + a copy appended to Sent)
test/fake-imap.mjs        the fake IMAP server the above drives (a helper, not a test)
test/fake-smtp.mjs        the fake SMTP server (a helper, not a test)
test/attachments.mjs      15 checks: real MIME to disk, Chinese filenames, traversal guard
test/validate-manifest.mjs 17 checks: bundle declaration, patch dialect, files coverage, engines.dsh
```

---

## Publishing to a plugin market

The minimum for an installable plugin is already met: `package.json` declares `dsh.bundle.patch` pointing at a shipped `cordis.patch.yml`, and every runtime file is listed in `files`.

DSH actually ships **three unrelated market mechanisms**, with different submission routes:

| # | Mechanism | How to get listed |
|---|---|---|
| 1 | **format-1 market index** (`market-index.json`) | **There is no official index to submit to.** You host your own `market-index.json` (HTTP(S) only — `file://` is refused) and users add it as an index source. Test locally over loopback HTTP. |
| 2 | **DSH Community Market** | Publish a conforming **catalog source** (static manifest plus a `/v1/plugins` endpoint); any user can register it, with no central approval. |
| 3 | **`dshmarket`** | The market actually enabled in this machine's `desktop` profile. Its catalog comes from the curated `awesome-dsh-plugin` registry — getting listed means **opening a PR against `github.com/awesome-dsh-plugin/awesome-dsh-plugin`**. |

So the practical route is **#3**: publish to npm, then send a PR to `awesome-dsh-plugin`.

The ready-to-paste catalog entry, the PR steps, the npm release flow and the capability disclosure are in [docs/marketplace-listing.md](docs/marketplace-listing.md).

Verified rules worth knowing:

- **No signing, checksum or provenance is required** by any of the three.
- The installer **does enforce** `engines.dsh` (otherwise `@deepseek-ai/dsh*` peer dependencies). This package declares `engines.dsh: ">=0.2.0-rc.1 <0.3.0"`.
- A package without `dsh.bundle` is refused as `not-bundle`.
- Icons must be an `https:` or same-origin URL, or inline `data:` (SVG/PNG/JPEG/WebP, ≤ 32 KiB decoded).
- `DSHM_REGISTRY_URL` points `dshmarket` at a self-hosted catalog JSON for local end-to-end install testing. This repository also ships a more thorough install-verification harness — see [`_research/install-verification/README.md`](../_research/install-verification/README.md).

Pre-publish checklist:

- [ ] `npm pack --dry-run` includes `lib/`, `locale/`, `cordis.patch.yml`, `icon.svg`, `README*.md`, `LICENSE`, and excludes `node_modules/`, `test/`, `docs/`.
- [ ] `version`, `description` and the `dsh`/`dsh-plugin`/`deepseek-harness` keywords are set.
- [ ] `locale/en.json` and `locale/zh.json` both carry `meta.title` and `meta.description`.
- [ ] The icon is your own original work or permissively licensed.
- [ ] `npm test` is green (191 checks).
- [ ] The README's provider table matches the code (`node test/print-tools.mjs`).
- [ ] Any `repository` / `homepage` you add is a real, reachable URL — **never a placeholder**.

On shipping your own UI: this plugin needs no `dsh.client` section and no custom page. Declaring the Host-side
`Config` is enough for DSH to generate a settings form for it (editable fields via `.volatile()`, the
authorization code redacted via `role('secret')`). A client module is only needed for interactions a schema
cannot express — a "test connection" button, say — and that is a later addition, not a prerequisite for listing.

---

## License

MIT — see [LICENSE](./LICENSE).