import { defineConfig } from 'vitest/config'

// Startup and background-task logs are noise in a test report.
export default defineConfig({ test: { env: { LOG_LEVEL: 'silent' } } })
