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
assert.match(
  template,
  /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{PRODUCTNAME\}"/,
  'Tauri NSIS template should default current-user installs to Electron Builder location',
)
assert.match(
  template,
  /Call RestorePreviousInstallLocation[\s\S]*\$INSTDIR == "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"[\s\S]*StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{PRODUCTNAME\}"/,
  'Tauri NSIS template should migrate the earlier Tauri default install location',
)
assert.ok(
  template.indexOf('!insertmacro NSIS_HOOK_PREINSTALL') < template.indexOf('SetOutPath $INSTDIR'),
  'preinstall hook must run before SetOutPath so redirected install dirs affect extraction',
)
assert.match(
  template,
  /Delete "\$INSTDIR\\better-agent-terminal\.exe"/,
  'Tauri NSIS installer should remove the previous lowercase Tauri executable after switching back to the Electron executable name',
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
