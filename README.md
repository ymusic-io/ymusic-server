# ymusic-remote-config

Fastify server with one endpoint: the config YMusic asks for at startup.

```
GET /v1/config?os=windows&appVer=1233&deviceId=abc
GET /healthz
```

```json
{
  "variableA": 123,
  "featureX": true,
  "newVersion": {
    "url": "https://cfg.ymusic.io/static/ymusic-1234-windows-x64.exe",
    "changelog": "https://cfg.ymusic.io/static/changelog-1234.md",
    "size": "0",
    "checksum": ""
  },
  "wvJs": { "version": 123, "url": "https://cfg.ymusic.io/static/webview_ymusic-123.js" },
  "engineJs": { "version": 11, "url": "https://cfg.ymusic.io/static/engine_ymusic-11.js" }
}
```

`newVersion` is `null` when the caller is already current, or when its platform has no release.

`wvJs` and `engineJs` are always the latest; the client compares each `version` against the bundle it
already has. Neither is per-platform — the webview script runs in the WebView and the engine in
QuickJS, on every platform — so bumping one ships a scraping fix without an app release.

## Layout

```
src/routes/config.ts    GET /v1/config — the rules and the handler
src/routes/health.ts    GET /healthz
src/routes/index.ts     the list every route is registered from
src/server.ts           builds the fastify instance
src/index.ts            reads env, listens
```

Adding an endpoint is a file in `src/routes/` and a line in `src/routes/index.ts`. Listed explicitly
rather than autoloaded from disk: two routes do not justify a dependency on `@fastify/autoload`, and
an explicit list means the compiler catches a missing module instead of the server starting up
quietly without that route.

## Editing the rules

They are in [`src/routes/config.ts`](src/routes/config.ts), beside the handler that serves them —
`resolveConfig` is a plain function, so they test without HTTP. A release is three lines in the
`RELEASES` table: the newest build per platform and the version below which it is offered.

`os` is a coarse platform name (`windows`, `android`, …), matched lower-case. `appVer` is the caller's
build number; a missing or unparseable one falls back to `-1`, which is older than every release, so
such a caller is offered the update rather than quietly left behind. `deviceId` is accepted for
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

`PORT` (8787), `HOST` (0.0.0.0), `LOG_LEVEL` (info). `trustProxy` is on, so terminate TLS at the
proxy.

## One thing to know about `newVersion`

The response is unsigned, and `checksum` arrives beside the `url` it describes — so it catches a
corrupted download, not a substituted one. Whatever consumes `newVersion` should verify the
downloaded artifact against a key pinned in the app; otherwise this endpoint is a place where
anything that can answer for it can choose what code the app installs.
