import { app } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'

export interface ProfileEntry {
  id: string
  name: string
  type: 'local' | 'remote'
  remoteHost?: string
  remotePort?: number
  remoteToken?: string
  createdAt: number
  updatedAt: number
}

export interface ProfileIndex {
  profiles: ProfileEntry[]
  activeProfileId: string
}

export interface ProfileSnapshot {
  id: string
  name: string
  version: 1
  workspaces: unknown[]
  activeWorkspaceId: string | null
  activeGroup: string | null
}

function getProfilesDir(): string {
  return path.join(app.getPath('userData'), 'profiles')
}

function getIndexPath(): string {
  return path.join(getProfilesDir(), 'index.json')
}

function getProfilePath(id: string): string {
  return path.join(getProfilesDir(), `${id}.json`)
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '') || 'profile'
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getProfilesDir(), { recursive: true })
}

async function readIndex(): Promise<ProfileIndex> {
  try {
    const data = await fs.readFile(getIndexPath(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return { profiles: [], activeProfileId: 'default' }
  }
}

async function writeIndex(index: ProfileIndex): Promise<void> {
  await ensureDir()
  await fs.writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

async function readSnapshot(id: string): Promise<ProfileSnapshot | null> {
  try {
    const data = await fs.readFile(getProfilePath(id), 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function writeSnapshot(snapshot: ProfileSnapshot): Promise<void> {
  await ensureDir()
  await fs.writeFile(getProfilePath(snapshot.id), JSON.stringify(snapshot, null, 2), 'utf-8')
}

// Initialize on first use: create default profile from current workspaces.json
async function ensureInitialized(): Promise<ProfileIndex> {
  const index = await readIndex()
  if (index.profiles.length > 0) return index

  // First time: create default profile from existing workspaces
  const now = Date.now()
  const defaultEntry: ProfileEntry = {
    id: 'default',
    name: 'Default',
    type: 'local',
    createdAt: now,
    updatedAt: now,
  }

  // Read current workspaces.json to seed the default profile
  let workspacesData: { workspaces: unknown[]; activeWorkspaceId: string | null; activeGroup: string | null } = {
    workspaces: [],
    activeWorkspaceId: null,
    activeGroup: null,
  }
  try {
    const raw = await fs.readFile(path.join(app.getPath('userData'), 'workspaces.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    workspacesData = {
      workspaces: parsed.workspaces || [],
      activeWorkspaceId: parsed.activeWorkspaceId || null,
      activeGroup: parsed.activeGroup || null,
    }
  } catch { /* no existing workspaces */ }

  const snapshot: ProfileSnapshot = {
    id: 'default',
    name: 'Default',
    version: 1,
    workspaces: workspacesData.workspaces,
    activeWorkspaceId: workspacesData.activeWorkspaceId,
    activeGroup: workspacesData.activeGroup,
  }

  const newIndex: ProfileIndex = {
    profiles: [defaultEntry],
    activeProfileId: 'default',
  }

  await writeSnapshot(snapshot)
  await writeIndex(newIndex)
  return newIndex
}

export class ProfileManager {
  async list(): Promise<{ profiles: ProfileEntry[]; activeProfileId: string }> {
    const index = await ensureInitialized()
    return { profiles: index.profiles, activeProfileId: index.activeProfileId }
  }

  async create(name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string }): Promise<ProfileEntry> {
    const index = await ensureInitialized()
    let id = toSlug(name)
    // Ensure unique ID
    if (index.profiles.some(p => p.id === id)) {
      id = `${id}-${Date.now()}`
    }

    const now = Date.now()
    const entry: ProfileEntry = {
      id,
      name,
      type: options?.type || 'local',
      remoteHost: options?.remoteHost,
      remotePort: options?.remotePort,
      remoteToken: options?.remoteToken,
      createdAt: now,
      updatedAt: now,
    }

    // Only create snapshot for local profiles
    if (entry.type === 'local') {
      const snapshot: ProfileSnapshot = {
        id,
        name,
        version: 1,
        workspaces: [],
        activeWorkspaceId: null,
        activeGroup: null,
      }
      await writeSnapshot(snapshot)
    }

    index.profiles.push(entry)
    await writeIndex(index)
    return entry
  }

  // Save current workspaces.json state into a profile
  async save(profileId: string): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false

    // Read current workspaces.json
    let workspacesData: { workspaces: unknown[]; activeWorkspaceId: string | null; activeGroup: string | null }
    try {
      const raw = await fs.readFile(path.join(app.getPath('userData'), 'workspaces.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      workspacesData = {
        workspaces: parsed.workspaces || [],
        activeWorkspaceId: parsed.activeWorkspaceId || null,
        activeGroup: parsed.activeGroup || null,
      }
    } catch {
      return false
    }

    const snapshot: ProfileSnapshot = {
      id: profileId,
      name: entry.name,
      version: 1,
      workspaces: workspacesData.workspaces,
      activeWorkspaceId: workspacesData.activeWorkspaceId,
      activeGroup: workspacesData.activeGroup,
    }

    await writeSnapshot(snapshot)
    entry.updatedAt = Date.now()
    await writeIndex(index)
    return true
  }

  // Load a profile: write its snapshot into workspaces.json and set as active
  async load(profileId: string): Promise<ProfileSnapshot | null> {
    const index = await ensureInitialized()
    if (!index.profiles.some(p => p.id === profileId)) return null

    const snapshot = await readSnapshot(profileId)
    if (!snapshot) return null

    // Write to workspaces.json
    const workspacesData = JSON.stringify({
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      activeGroup: snapshot.activeGroup,
    })
    await fs.writeFile(path.join(app.getPath('userData'), 'workspaces.json'), workspacesData, 'utf-8')

    // Update active profile
    index.activeProfileId = profileId
    await writeIndex(index)

    return snapshot
  }

  async delete(profileId: string): Promise<boolean> {
    if (profileId === 'default') return false // Cannot delete default

    const index = await ensureInitialized()
    const idx = index.profiles.findIndex(p => p.id === profileId)
    if (idx === -1) return false

    index.profiles.splice(idx, 1)

    // If deleting active profile, switch to default
    if (index.activeProfileId === profileId) {
      index.activeProfileId = 'default'
    }

    await writeIndex(index)

    // Remove snapshot file
    try { await fs.unlink(getProfilePath(profileId)) } catch { /* ignore */ }

    return true
  }

  async rename(profileId: string, newName: string): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false

    entry.name = newName
    entry.updatedAt = Date.now()
    await writeIndex(index)

    // Also update snapshot name
    const snapshot = await readSnapshot(profileId)
    if (snapshot) {
      snapshot.name = newName
      await writeSnapshot(snapshot)
    }

    return true
  }

  async duplicate(profileId: string, newName: string): Promise<ProfileEntry | null> {
    const snapshot = await readSnapshot(profileId)
    if (!snapshot) return null

    const entry = await this.create(newName)

    // Copy workspace data from source
    const newSnapshot: ProfileSnapshot = {
      ...snapshot,
      id: entry.id,
      name: newName,
    }
    await writeSnapshot(newSnapshot)

    return entry
  }

  async update(profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string }): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false

    if (updates.remoteHost !== undefined) entry.remoteHost = updates.remoteHost
    if (updates.remotePort !== undefined) entry.remotePort = updates.remotePort
    if (updates.remoteToken !== undefined) entry.remoteToken = updates.remoteToken
    entry.updatedAt = Date.now()
    await writeIndex(index)
    return true
  }

  async getProfile(profileId: string): Promise<ProfileEntry | null> {
    const index = await ensureInitialized()
    return index.profiles.find(p => p.id === profileId) || null
  }

  async getActiveProfileId(): Promise<string> {
    const index = await ensureInitialized()
    return index.activeProfileId
  }

  async setActiveProfileId(profileId: string): Promise<void> {
    const index = await ensureInitialized()
    index.activeProfileId = profileId
    await writeIndex(index)
  }
}
