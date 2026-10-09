import type { FastifyPluginAsync } from 'fastify'
import configRoutes from './config.js'
import healthRoutes from './health.js'
import linkRoutes from './link.js'
import pulseRoutes from './pulse.js'

/**
 * Every route the server exposes. Adding an endpoint is a file in this folder and a line here.
 *
 * Listed explicitly rather than discovered from disk: a few entries do not justify a dependency on
 * @fastify/autoload, and an explicit list means the compiler sees a missing or misnamed module
 * instead of the server simply starting up without that route.
 */
export const routes: FastifyPluginAsync[] = [healthRoutes, configRoutes, pulseRoutes, linkRoutes]
