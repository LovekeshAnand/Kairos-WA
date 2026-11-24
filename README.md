# Kairos

Kairos quietly watches the WhatsApp DMs you choose and files what matters — meeting requests,
documents, orders, real business questions — into your Notion. Small talk never leaves your PC.

## Editions

| | Windows | macOS |
| --- | --- | --- |
| Package | `Kairos_<ver>_x64-setup.exe` (`npm run dist`) | `Kairos-mac.tar.gz` + `install.sh` (`npm run dist:mac`, app built in CI) |
| Window | Tauri app (system WebView2) + tray | Tauri app + menu bar (falls back to the browser page) |
| Background service | Detached engine started by the app; starts with Windows (Run key) | LaunchAgent `app.kairos.engine`, starts at login |
| Code signing | Not needed | Not needed: `curl -fsSL …/install.sh \| bash` (files fetched by curl are never quarantined) |
| Documents | `Documents\Kairos` | `~/Kairos` (macOS blocks background apps from `~/Documents`) |

Both editions run the same engine and the same UI; the engine serves the page itself. The old
Electron shell (`app/main.js`, `npm run start:electron` / `dist:electron`) still works and can be
deleted once the Tauri build has proven itself.

## When things go wrong (and what Kairos does)

| Situation | Behaviour |
| --- | --- |
| Laptop off / asleep / engine crashed | The gap is logged in Activity → *Offline*. On reconnect, each watched chat's recent history is read (Standard engine, ≤ 7 days, one chat at a time) and anything newer than the last seen message is filed. Message ids are persisted, so nothing is filed twice. Baileys: WhatsApp replays missed messages itself. |
| Monitoring paused | Messages are kept aside in `pause-buffer.json`, never filed. On resume a card offers **Sync all / Choose chats / Skip**; late arrivals for a settled pause re-open it. |
| Notion down / offline / rate-limited | The filing goes to `outbox.json` and retries (1 m → 6 h backoff). *Retry now* / *Dismiss* in the UI. Items logged before Notion is connected file themselves once it is. |
| Phone offline ~14 days (WhatsApp unlinks) | QR modal + tray notification; catch-up runs after the re-scan. |
| OpenWA crashes, hangs or outlives the engine | Watchdog restarts it (crash backoff reset after 10 healthy minutes); a leftover one is adopted and supervised. |
| App updated while an old engine runs | `/health` reports the version; the shell stops the old engine and starts the new one. |
| Port 2790 taken by another program | The shell says so instead of loading someone else's page. |
| `config.json` corrupt | Restored from `config.json.bak`; the bad copy is kept as `config.json.corrupt-<time>`. |

Settings → *Copy diagnostics* copies recent logs with secrets and phone numbers removed.

## Releases and updates

Set `"kairos": { "releases": "owner/repo" }` in `package.json` (a public GitHub repo), then push a
tag: `git tag v1.1.0 && git push --tags`. `.github/workflows/release.yml` builds both editions and
publishes the release. The app checks for a newer release twice a day and shows a banner; Mac users
update by re-running the install line.

## How it fits together

```
Kairos.exe (Electron) or your browser (Mac)  ← just a view; close it any time
   │  loads and talks to http://127.0.0.1:2790
   ▼
engine/  (detached Node process)             ← keeps running when the window is closed
   ├─ OpenWA  (vendor/openwa, headless WhatsApp Web via whatsapp-web.js, port 2785)
   │     └─ webhooks → engine /hook  (HMAC-signed)
   ├─ Epsilon (llama-server + multilingual-e5-small, port 2791, loads on demand)
   └─ Notion  (Products · Contacts · Employees · Orders)
```

| Event in a watched DM | Where it lands |
| --- | --- |
| Meeting request (`kal 4 baje mil sakte hai?`) | To-do on the person's page + *Meeting Request* / *Meeting Date* columns |
| Document (PDF, doc, captioned invoice photo) | `Documents\Kairos\<Contact>\<YYYY-MM>\` on disk + uploaded to the person's page |
| Order | New row in **Orders**, linked to the contact |
| Catalog product shared | New row in **Products** |
| Business question / payment / complaint | Note on the person's page |
| Greetings, thanks, memes, stickers, voice notes, OTPs | Counted as noise, never stored |

Contacts you tag as **Employee** in *Chats* are filed in **Employees** instead of **Contacts**.

## Sorting (Epsilon)

1. Free rules drop obvious noise (stickers, "ok", emoji, OTPs) and catch clear keywords.
2. Everything else goes to the Epsilon runtime: a 132 MB multilingual embedding model that matches
   the message against the examples in [`engine/examples.js`](engine/examples.js) (nearest neighbours).
   ~10 ms per message on CPU; unloads after 5 idle minutes (Epsilon's `idle_timeout`).
3. To teach Kairos a new pattern, add an example sentence to `engine/examples.js`.

A 0.5B chat model was tried first and labelled 6/16 test messages correctly; the embedding model
gets 29/30 on a mixed English/Hinglish set.

## Staying off WhatsApp's radar

* **Read-only, enforced in code** — `engine/openwa.js` refuses every call except session start/stop
  and webhook wiring. Sending, read receipts, typing, presence and reactions throw. (`npm test` checks it.)
* Runs on the user's own PC and IP, one linked device, session persisted (no repeated QR scans).
* Reconnects back off (15 s base, OpenWA) and the OpenWA process restarts with exponential backoff.
* Address book read at most every 10 minutes; profile pictures, statuses and groups are never touched.

## Development

```powershell
npm install
npm run setup     # portable Node 22, pinned OpenWA build, headless Chrome → vendor/
npm start         # Tauri shell in debug mode; runs the engine straight from this folder
npm test
npm run dist      # packs src-tauri/runtime.tar, then the Windows installer (src-tauri/target/release/bundle/nsis)
npm run dist:mac  # dist/Kairos-mac.tar.gz + dist/install.sh (add KAIROS_MAC_APP=<path to Kairos.app> on a Mac)
```

Engine-only testing without touching your real data: `KAIROS_DATA=<tmp dir> vendor/node/node.exe engine/index.js`.

Data lives in `%APPDATA%\Kairos` (Mac: `~/Library/Application Support/Kairos`) (config, OpenWA session, Epsilon model, logs,
activity, outbox, pause buffer), documents in `Documents\Kairos`. The unpacked runtime lives in `%LOCALAPPDATA%\Kairosuntime\<version>`.
Logs: `logs\engine.log` and `logs\openwa.log`.

## Notes

* **Fonts** — Qurova is the *demo* version: personal use only, and it ships placeholder digits, so
  digits fall back to Outfit (SIL OFL). Buy the Qurova licence before selling Kairos.
* OpenWA is pinned to commit `fd8c6e3`, with `better-sqlite3` pinned to 13.0.2 (13.0.3 was
  published without its prebuilt binaries). See `scripts/setup.js`.
* Notion uploads: free workspaces cap files at 5 MB; larger files stay on disk and the Notion page
  shows where.
