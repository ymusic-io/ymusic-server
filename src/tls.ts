import { readFileSync } from 'node:fs'

export interface TlsFiles {
  certFile: string
  keyFile: string
}

/** Both set = HTTPS, neither = HTTP; one without the other is a config error, not a downgrade. */
export function tlsFiles(certFile: string | undefined, keyFile: string | undefined, prefix: string): TlsFiles | undefined {
  if (!certFile && !keyFile) return undefined
  if (!certFile || !keyFile) throw new Error(`${prefix}_CERT and ${prefix}_KEY must be set together`)
  return { certFile, keyFile }
}

export function httpsOptions(tls: TlsFiles | undefined): { https?: { cert: string; key: string } } {
  return tls ? { https: { cert: readFileSync(tls.certFile, 'utf8'), key: readFileSync(tls.keyFile, 'utf8') } } : {}
}
