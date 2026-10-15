import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Host configuration; no credential value is accepted from a browser. */
export interface Options {
  codexPath: string
  dataDirectory: string
  pollIntervalMs: number
  requestTimeoutMs: number
  streamIdleTimeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
}

export const Config: Schema<Options> = Schema.object({
  codexPath: Schema.string().default(''),
  dataDirectory: Schema.string().default(''),
  pollIntervalMs: Schema.number().min(15_000).max(3_600_000).default(60_000),
  requestTimeoutMs: Schema.number().min(1_000).max(300_000).default(30_000),
  streamIdleTimeoutMs: Schema.number().min(5_000).max(600_000).default(120_000),
  maxRequestImageBytes: Schema.number().min(1).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  requestImagePixelBudget: Schema.number().min(1).default(4_000_000),
  requestImageMaxBytes: Schema.number().min(1).default(5 * 1024 * 1024),
})

/** Resolve the pinned Codex native executable without an intermediate shell. */
export function bundledCodex(): string {
  const require = createRequire(import.meta.url)
  const codexRequire = createRequire(require.resolve('@openai/codex/package.json'))
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null
  const target = process.platform === 'win32' ? 'pc-windows-msvc'
    : process.platform === 'darwin' ? 'apple-darwin'
      : process.platform === 'linux' ? 'unknown-linux-musl' : null
  if (!cpu || !target) throw new Error('Unsupported Codex platform; configure an absolute codexPath.')
  const packageName = `@openai/codex-${process.platform}-${process.arch}`
  const packageRoot = dirname(codexRequire.resolve(`${packageName}/package.json`))
  const path = join(packageRoot, 'vendor', `${cpu}-${target}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (!existsSync(path)) throw new Error('Bundled Codex executable is missing. Reinstall the plugin with optional dependencies enabled.')
  return path
}

/** Resolve an independent login home; never use the user's existing Codex login cache. */
export function runtimePaths(config: Options): { codexPath: string; codexHome: string } {
  if (config.codexPath && !isAbsolute(config.codexPath)) throw new Error('codexPath must be an absolute executable path.')
  if (config.dataDirectory && !isAbsolute(config.dataDirectory)) throw new Error('dataDirectory must be an absolute path.')
  return {
    codexPath: config.codexPath || bundledCodex(),
    codexHome: config.dataDirectory || resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'openai-subscription'),
  }
}
