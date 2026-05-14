import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const nsis = tauriConfig?.bundle?.windows?.nsis

assert.equal(nsis?.installMode, 'currentUser', 'Tauri NSIS must keep the per-user install mode')
assert.equal(nsis?.template, 'windows/installer.nsi', 'Tauri NSIS must use the project installer template')
assert.equal(nsis?.installerHooks, 'windows/nsis-hooks.nsh', 'Tauri NSIS must load the installer hook')

const hook = await readFile(new URL('../src-tauri/windows/nsis-hooks.nsh', import.meta.url), 'utf8')
const template = await readFile(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8')

assert.match(
  hook,
  /LOCALAPPDATA\\Programs\\BetterAgentTerminal/,
  'Tauri NSIS default install directory should stay under the per-user Programs directory',
)
assert.match(
  hook,
  /LOCALAPPDATA\\BetterAgentTerminal/,
  'Tauri NSIS hook should only rewrite the Tauri default directory',
)
assert.doesNotMatch(
  template,
  /^\s*Page custom PageReinstall PageLeaveReinstall/m,
  'Tauri NSIS reinstall page should stay disabled so upgrades do not prompt to uninstall the old install',
)
assert.match(
  template,
  /skip Tauri's default uninstall\/reinstall prompt/,
  'Tauri NSIS template should document why the reinstall page is disabled',
)

console.log('tauri-windows-installer: passed')
