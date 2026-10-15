import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') throw new Error('The Windows desktop ZIP is packaged on Windows. npm pack remains available on other platforms.')
if (!process.env.npm_execpath) throw new Error('Run through npm run package:desktop.')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const stage = resolve('.local', 'desktop-release', manifest.version)
await mkdir(stage, { recursive: true })
const archive = resolve(packed.filename)
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
await copyFile(archive, join(stage, packed.filename))
await copyFile('desktop/Install-Plugin.ps1', join(stage, 'Install-Plugin.ps1'))
await copyFile('desktop/README.zh.md', join(stage, 'README.zh.md'))
await writeFile(join(stage, 'release.json'), JSON.stringify({
  schemaVersion: 1, packageName: manifest.name, version: manifest.version,
  packageFile: packed.filename, sha256, runtimeVersions: ['0.2.0-rc.2'], nextVersions: ['2.0.17-next'],
}, null, 2) + '\n')
const output = resolve(`dsh-openai-subscription-desktop-${manifest.version}.zip`)
const quote = value => `'${value.replaceAll("'", "''")}'`
const paths = [packed.filename, 'Install-Plugin.ps1', 'README.zh.md', 'release.json'].map(file => quote(join(stage, file)))
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference = 'Stop'\nCompress-Archive -LiteralPath @(${paths.join(',')}) -DestinationPath ${quote(output)} -Force`], { stdio: 'inherit', windowsHide: true })
console.log(JSON.stringify({ package: archive, desktopZip: output, sha256 }, null, 2))
