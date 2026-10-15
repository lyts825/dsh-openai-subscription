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

/** Stable optional facts supplied by DSH's profile runner before plugins mount. */
interface RuntimeContext {
  get(name: string): unknown
}

interface ProfileLocation {
  name: string
  dir: string
  home: string
}

function profileLocation(ctx?: RuntimeContext): ProfileLocation | undefined {
  const value = ctx?.get('profileContext')
  if (!value || typeof value !== 'object') return
  const profile = value as Partial<ProfileLocation>
  if (typeof profile.name !== 'string' || !profile.name
    || typeof profile.dir !== 'string' || !isAbsolute(profile.dir)
    || typeof profile.home !== 'string' || !isAbsolute(profile.home)) return
  return { name: profile.name, dir: resolve(profile.dir), home: resolve(profile.home) }
}

function launchHome(ctx?: RuntimeContext): string {
  const snapshot = ctx?.get('launchEnvironment') as { get?: (name: string) => { value?: unknown } | undefined } | undefined
  const configured = typeof snapshot?.get === 'function' ? snapshot.get('DSH_HOME')?.value : process.env.DSH_HOME
  if (typeof configured !== 'string' || !configured.trim()) return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return resolve(homedir(), configured.slice(2))
  return resolve(configured)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Resolve independent profile credentials; never move or reuse the user's Codex login cache. */
export function runtimePaths(config: Options, ctx?: RuntimeContext): { codexPath: string; codexHome: string } {
  if (config.codexPath && !isAbsolute(config.codexPath)) throw new Error('codexPath must be an absolute executable path.')
  if (config.dataDirectory && !isAbsolute(config.dataDirectory)) throw new Error('dataDirectory must be an absolute path.')
  const profile = profileLocation(ctx)
  const home = profile?.home ?? launchHome(ctx)
  // Keep 0.1's default web login. Desktop and custom profiles own their credentials,
  // including an Electron profile called "web". Missing profile facts retain the old fallback.
  const legacyWeb = profile?.name === 'web'
    && samePath(profile.dir, resolve(profile.home, 'profiles', 'web'))
    && !process.versions.electron
  const root = profile && !legacyWeb ? profile.dir : home
  return {
    codexPath: config.codexPath || bundledCodex(),
    codexHome: config.dataDirectory || join(root, 'openai-subscription'),
  }
}
