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
  "engineJs": { "version": 69, "url": "https://cfg.ymusic.io/static/engine-69.js", "signature": "MEYCIQ…" },
  "playerJs": null
}
```

`newVersion` is `null` when the caller is already current, or when its platform has no release.

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

Upload the file to that url, then paste the printed `{version, url, signature}` into `ENGINE_JS` /
`PLAYER_JS` in [`src/routes/config.ts`](src/routes/config.ts). The signature covers
`<name>:<version>:<sha256 of the file>`, so a file cannot be re-published under another version or
as the other bundle without signing it again.

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
