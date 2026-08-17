import { defineConfig } from 'vitest/config'

// The server logs every request at info; useful in production, noise in a test report.
export default defineConfig({ test: { env: { LOG_LEVEL: 'silent' } } })
