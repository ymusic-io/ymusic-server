import type { FastifyInstance } from 'fastify'
import { resolveAppConfig } from '../appConfig.js'
import { header } from '../headers.js'

/**
 * What the app asks for at startup: feature flags, the newest JS bundles, and whether a newer build
 * exists. The rules are data (app_config, edited in the dashboard); see appConfig.ts.
 *
 * No cache headers on purpose — caching is the reverse proxy's job, and a Cache-Control set here
 * would override whatever it decides.
 */
export default async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/config', async (req) => {
    // The common context — os, arch, appVer, device uuid — rides as headers on every API call;
    // this route reads all but the uuid. Fastify lowercases header names.
    const os = (header(req.headers['x-os']) ?? '').toLowerCase()
    // || not ??: parseInt returns NaN, which is nullish to nobody, and NaN < anything is false — so
    // a junk appVer would silently mean "up to date" rather than falling back to -1.
    const appVer = Number.parseInt(header(req.headers['x-app-ver']) ?? '', 10) || -1
    const arch = (header(req.headers['x-arch']) ?? '').toLowerCase()

    return resolveAppConfig(await app.appConfig.current(), { os, arch, appVer })
  })
}
