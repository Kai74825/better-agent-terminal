#!/usr/bin/env node
// Prepare the minimal node_modules tree required by the bundled Tauri
// sidecar. `dist/server.mjs` contains the JS dependencies; this directory
// only keeps platform native binaries that must remain real files.

import { cp, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sidecarRoot = join(repoRoot, 'node-sidecar')
const sourceRoot = join(sidecarRoot, 'node_modules')
const outputRoot = join(sidecarRoot, 'dist-node_modules')
const rootRequire = createRequire(join(repoRoot, 'package.json'))

const claudeNativePackages = {
  'win32-x64': 'claude-agent-sdk-win32-x64',
  'win32-arm64': 'claude-agent-sdk-win32-arm64',
  'darwin-x64': 'claude-agent-sdk-darwin-x64',
  'darwin-arm64': 'claude-agent-sdk-darwin-arm64',
  'linux-x64': 'claude-agent-sdk-linux-x64',
  'linux-arm64': 'claude-agent-sdk-linux-arm64',
}

const codexPlatformPackages = {
  'win32-x64': 'codex-win32-x64',
  'win32-arm64': 'codex-win32-arm64',
  'darwin-x64': 'codex-darwin-x64',
  'darwin-arm64': 'codex-darwin-arm64',
  'linux-x64': 'codex-linux-x64',
  'linux-arm64': 'codex-linux-arm64',
}

const codexTargetTriples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

async function assertDirectory(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new Error(`${label} missing: ${path} (${err.message})`)
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}

async function assertFile(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new Error(`${label} missing: ${path} (${err.message})`)
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a file: ${path}`)
  }
}

async function firstExistingDirectory(candidates, label) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch { /* try next candidate */ }
  }
  throw new Error(`${label} missing; tried:\n${candidates.map(path => `  - ${path}`).join('\n')}`)
}

export async function prepareTauriSidecarNodeModules(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const key = platformKey(platform, arch)
  const claudePackage = claudeNativePackages[key]
  if (!claudePackage) {
    throw new Error(`unsupported platform/arch for sidecar native package: ${key}`)
  }
  const codexPackage = codexPlatformPackages[key]
  const codexTriple = codexTargetTriples[key]
  if (!codexPackage || !codexTriple) {
    throw new Error(`unsupported platform/arch for Codex native package: ${key}`)
  }

  const anthropicSourceLink = join(sourceRoot, '@anthropic-ai', claudePackage)
  await assertDirectory(anthropicSourceLink, '@anthropic-ai Claude native package')
  const anthropicSource = await realpath(anthropicSourceLink)
  const codexSourceCandidates = [
    join(repoRoot, 'node_modules', '@openai', codexPackage),
    join(repoRoot, 'node_modules', '.pnpm', 'node_modules', '@openai', codexPackage),
  ]
  try {
    const codexMetaPackage = dirname(rootRequire.resolve('@openai/codex/package.json'))
    const codexMetaRealPath = await realpath(codexMetaPackage)
    codexSourceCandidates.push(join(dirname(codexMetaRealPath), codexPackage))
  } catch { /* @openai/codex is not installed as a direct resolver target */ }
  const codexSource = await realpath(await firstExistingDirectory(codexSourceCandidates, '@openai Codex native package'))
  const codexExe = platform === 'win32' ? 'codex.exe' : 'codex'
  await assertFile(
    join(codexSource, 'vendor', codexTriple, 'codex', codexExe),
    '@openai Codex native binary',
  )

  await rm(outputRoot, { recursive: true, force: true })
  const anthropicTargetRoot = join(outputRoot, '@anthropic-ai')
  await mkdir(anthropicTargetRoot, { recursive: true })
  await cp(anthropicSource, join(anthropicTargetRoot, claudePackage), {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  })
  const openaiTargetRoot = join(outputRoot, '@openai')
  await mkdir(openaiTargetRoot, { recursive: true })
  await cp(codexSource, join(openaiTargetRoot, codexPackage), {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  })

  return {
    outputRoot,
    packages: [`@anthropic-ai/${claudePackage}`, `@openai/${codexPackage}`],
  }
}

async function main() {
  const result = await prepareTauriSidecarNodeModules()
  console.log(`[prepare-tauri-sidecar-node-modules] wrote ${result.outputRoot}`)
  for (const pkg of result.packages) {
    console.log(`[prepare-tauri-sidecar-node-modules] kept ${pkg}`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((err) => {
    console.error('[prepare-tauri-sidecar-node-modules] failed:', err.message || err)
    process.exit(1)
  })
}
