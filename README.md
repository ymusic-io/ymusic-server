# ymusic-server

Fastify server with one endpoint: the config YMusic asks for at startup. Its rules live in the
database (`app_config`) and are edited in the [dashboard](#dashboard).

```
GET /v1/config      x-os: windows, x-arch: x64, x-app-ver: 1233, x-device-id: …
GET /healthz
```

```json
{
  "features": { "variableA": 123, "featureX": true },
  "appUpdate": {
    "versionCode": 1234,
    "versionName": "4.1.0",
    "notes": "What changed",
    "url": "https://cfg.ymusic.io/static/YMusic-4.1.0.msi",
    "size": 98765432,
    "sha256": "9f2c…",
    "signature": "MEUCIQ…"
  },
  "engineJs": { "version": 69, "url": "https://cfg.ymusic.io/static/engine-69.js", "signature": "MEYCIQ…" },
  "playerJs": null
}
```

`appUpdate` is `null` when the caller is already current, or when its platform has no release.
Desktop platforms are keyed by OS and arch (`macos-arm64`, `windows-x64`, …). Android sends its
primary ABI and gets its split APK (`android-arm64-v8a`, `android-x86_64`) when one is published,
else the universal `android` APK.

`engineJs` and `playerJs` are the latest published bundles, or `null` while none is. The client
compares each `version` against the bundle it already has: engine.js goes live at once, player.js at
the next player session. Neither is per-platform — both run in QuickJS everywhere — so bumping one
ships a fix without an app release.

## Publishing a JS bundle

Every bundle entry is signed, and the app refuses a file whose bytes do not match its signature —
on download and again each time it loads the cached copy. Sign on your own machine; the private
key never goes to this server:

```bash
YM_BUNDLE_SIGNING_KEY=<base64 PKCS#8 P-256 key> \
  node scripts/sign-bundle.mjs engine 69 path/to/engine.js https://cfg.ymusic.io/static/engine-69.js
```

Upload the file to that url, then paste the printed `{version, url, signature}` into `engineJs` /
`playerJs` in the dashboard's App config and save. The signature covers
`<name>:<version>:<sha256 of the file>`, so a file cannot be re-published under another version or
as the other bundle without signing it again.

## Publishing an app release

Each `appUpdate` is the whole installer — an APK, DMG, MSI or DEB — signed with the UPDATE key (a
different key from the bundle one). Desktop installs nothing whose signature does not match; Android
relies on the OS, which only installs an APK signed with the installed app's certificate.

```bash
YM_UPDATE_SIGNING_KEY=<base64 PKCS#8 P-256 key> \
  node scripts/sign-app-update.mjs windows-x64 1234 4.1.0 YMusic-4.1.0.msi \
    https://cfg.ymusic.io/static/YMusic-4.1.0.msi notes.txt
```

Upload the installer to that url, then paste the printed entry into its platform's slot in
`releases` in the dashboard's App config and save. The signature covers
`app-<platform>:<versionCode>:<sha256 of the installer>`.

## QR sign-in relay

The desktop signs in by showing a QR; the phone that scans it sends its YouTube session through
`/v1/link`, a one-shot slot in the `device_links` table:

```
POST   /v1/link       → 201 {id, expiresInMs}    desktop opens a slot (10 minutes)
PUT    /v1/link/:id   → 204 | 404                phone fills it once (base64url text, ≤64KB)
GET    /v1/link/:id   → 200 payload | 204 | 404  desktop polls; the 200 deletes the row
DELETE /v1/link/:id   → 204                      desktop gives up
```

The payload is encrypted with a key that travels only inside the QR, so the database holds
ciphertext this server cannot read. Expired rows are swept whenever a slot is opened. Without a
database these routes answer 503.

## Layout

```
src/routes/config.ts    GET /v1/config
src/appConfig.ts        the config document: shape, defaults, validation, per-caller answer
src/configStore.ts      app_config versions, and the API's in-memory copy
src/routes/health.ts    GET /healthz
src/routes/link.ts      the QR sign-in relay (store: src/links.ts)
src/routes/index.ts     the list every route is registered from
src/server.ts           builds the fastify instance
src/index.ts            reads env, listens
src/stats.ts            nightly analytics rollups
src/dashboard/          the private dashboard server: Basic Auth, /api/analytics
dashboard/              its frontend (index.html + app.js), served as-is
```

Adding an endpoint is a file in `src/routes/` and a line in `src/routes/index.ts`. Listed explicitly
rather than autoloaded from disk: two routes do not justify a dependency on `@fastify/autoload`, and
an explicit list means the compiler catches a missing module instead of the server starting up
quietly without that route.

## Editing the rules

They are data, edited in the dashboard's App config (shape: [`src/appConfig.ts`](src/appConfig.ts)).
`flags` go to every caller under `features`, `flagsByOs.<os>` overrides them for one platform. A release is one entry
in `releases`, offered to every build of that platform below its `versionCode`.

`x-os` is a coarse platform name (`windows`, `android`, …) and `x-arch` the desktop CPU (`x64`,
`arm64`), both matched lower-case. `x-app-ver` is the caller's build number; a missing or unparseable one falls back to `-1`, which is older than every release, so
such a caller is offered the update rather than quietly left behind. `x-device-id` is accepted for
staged rollouts but no rule reads it yet.

## Caching and static files

Neither is this server's job. It sets no `Cache-Control` and no `ETag`, so the reverse proxy decides
caching without anything here overriding it, and installers/changelogs are served by the proxy from
disk.

## Running

```bash
npm install
npm run dev                     # tsx watch
npm run build && npm start      # dist/
npm test
```

`PORT` (8787), `HOST` (0.0.0.0), `LOG_LEVEL` (info). `YM_TLS_CERT` + `YM_TLS_KEY` serve HTTPS
(the self-signed `tls/api.ymix.io.*` origin cert); without them it is plain HTTP. `trustProxy` is on.

## Dashboard

A second server, private behind Basic Auth. The frontend (`dashboard/`) calls its JSON API:

- **Analytics** — `GET /api/analytics?from=&to=&os=`.
- **App config** — what `/v1/config` answers from (flags, per-OS flag overrides, releases, JS
  bundles; see `src/appConfig.ts`). `app_config` is append-only: saving appends a version, the
  newest is live, and a revert appends a copy of an old one, so every change can be diffed and
  undone. A save names the version it started from and is refused (409) if another landed in
  between. The API keeps the live config in memory and refreshes it in the background once it is
  a minute old, so a change reaches every API process within about a minute. An empty table is
  seeded once with the defaults.

```bash
npm run dev:dashboard           # node --env-file=dashboard.env, via tsx
npm run build && npm run start:dashboard
```

| Env | |
| --- | --- |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Basic Auth; required |
| `DASHBOARD_PG` | DSN, the `ymusic_server` role (it writes `app_config`); required. `YM_PG_CA/CERT/KEY` as the API |
| `DASHBOARD_HOST`, `DASHBOARD_PORT` | `127.0.0.1`, `8790` |
| `DASHBOARD_TLS_CERT`, `DASHBOARD_TLS_KEY` | HTTPS (`tls/dashboard.ymix.io.*`); plain HTTP without |
