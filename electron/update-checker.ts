import { app } from 'electron'
import https from 'https'

const GITHUB_REPO = 'tony1223/better-agent-terminal'

export interface ReleaseInfo {
  version: string
  tagName: string
  htmlUrl: string
  downloadUrl: string | null
  body: string
  publishedAt: string
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestRelease: ReleaseInfo | null
}

function getCurrentVersion(): string {
  return app.getVersion()
}

function compareVersions(current: string, latest: string): boolean {
  // Remove 'v' prefix if present
  const cleanCurrent = current.replace(/^v/, '')
  const cleanLatest = latest.replace(/^v/, '')

  // Split by '.' and compare each segment as numbers
  const currentParts = cleanCurrent.split('.').map(Number)
  const latestParts = cleanLatest.split('.').map(Number)

  // Compare each segment: a.b.c
  const maxLength = Math.max(currentParts.length, latestParts.length)
  for (let i = 0; i < maxLength; i++) {
    const currentPart = currentParts[i] || 0
    const latestPart = latestParts[i] || 0

    if (latestPart > currentPart) return true
    if (latestPart < currentPart) return false
  }

  return false // versions are equal
}

export function checkForUpdates(): Promise<UpdateCheckResult> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'Better-Agent-Terminal',
        'Accept': 'application/vnd.github.v3+json'
      }
    }

    const req = https.request(options, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            resolve({
              hasUpdate: false,
              currentVersion: getCurrentVersion(),
              latestRelease: null
            })
            return
          }

          const release = JSON.parse(data)
          const latestVersion = release.tag_name.replace(/^v/, '')
          const currentVersion = getCurrentVersion()

          // Find Windows zip download URL
          let downloadUrl: string | null = null
          if (release.assets && Array.isArray(release.assets)) {
            const winAsset = release.assets.find((asset: { name: string }) =>
              asset.name.endsWith('-win.zip') || asset.name.includes('win')
            )
            if (winAsset) {
              downloadUrl = winAsset.browser_download_url
            }
          }

          const latestRelease: ReleaseInfo = {
            version: latestVersion,
            tagName: release.tag_name,
            htmlUrl: release.html_url,
            downloadUrl,
            body: release.body || '',
            publishedAt: release.published_at
          }

          resolve({
            hasUpdate: compareVersions(currentVersion, latestVersion),
            currentVersion,
            latestRelease
          })
        } catch (error) {
          reject(error)
        }
      })
    })

    req.on('error', (error) => {
      reject(error)
    })

    req.end()
  })
}
