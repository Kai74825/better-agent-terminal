import { useState, useEffect, useCallback, Fragment } from 'react'

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function getExt(p: string): string {
  return p.split('.').pop()?.toLowerCase() || ''
}

function canPreview(p: string): boolean {
  const ext = getExt(p)
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext)
}

// Regex: Windows absolute path with file extension
const PATH_RE = /[A-Za-z]:[\\\/][\w\-. \\\/]+\.\w{1,10}/g

function splitByPaths(text: string): { text: string; isPath: boolean }[] {
  const parts: { text: string; isPath: boolean }[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  PATH_RE.lastIndex = 0
  while ((match = PATH_RE.exec(text)) !== null) {
    const path = match[0]
    if (!canPreview(path)) continue
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isPath: false })
    }
    parts.push({ text: path, isPath: true })
    lastIndex = match.index + path.length
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isPath: false })
  }
  return parts
}

interface FilePreviewModalProps {
  filePath: string
  onClose: () => void
}

function FilePreviewModal({ filePath, onClose }: FilePreviewModalProps) {
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setImageUrl(null)
    setError(null)
    setLoading(true)
    const ext = getExt(filePath)
    if (IMAGE_EXTS.has(ext)) {
      window.electronAPI.image.readAsDataUrl(filePath).then(url => {
        if (!cancelled) { setImageUrl(url); setLoading(false) }
      }).catch(() => {
        if (!cancelled) { setError('Failed to load image'); setLoading(false) }
      })
    } else {
      window.electronAPI.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
        } else {
          setContent(result.content || '')
        }
        setLoading(false)
      })
    }
    return () => { cancelled = true }
  }, [filePath])

  const fileName = filePath.split(/[\\\/]/).pop() || filePath

  return (
    <div className="path-preview-overlay" onClick={onClose}>
      <div className="path-preview-modal" onClick={e => e.stopPropagation()}>
        <div className="path-preview-header">
          <span className="path-preview-title" title={filePath}>{fileName}</span>
          <span className="path-preview-path">{filePath}</span>
          <button className="path-preview-close" onClick={onClose}>×</button>
        </div>
        <div className="path-preview-body">
          {loading && <div className="path-preview-status">Loading...</div>}
          {error && <div className="path-preview-status">{error}</div>}
          {imageUrl && (
            <div className="path-preview-image">
              <img src={imageUrl} alt={fileName} />
            </div>
          )}
          {content !== null && (
            <pre className="path-preview-text">{content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

interface LinkedTextProps {
  text: string
}

export function LinkedText({ text }: LinkedTextProps) {
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  const handleClick = useCallback((path: string) => {
    setPreviewPath(path)
  }, [])

  if (typeof text !== 'string') return <>{text}</>

  const parts = splitByPaths(text)
  if (parts.length === 1 && !parts[0].isPath) return <>{text}</>

  return (
    <>
      {parts.map((part, i) =>
        part.isPath ? (
          <span
            key={i}
            className="path-link"
            onClick={(e) => { e.stopPropagation(); handleClick(part.text) }}
            title={`Click to preview: ${part.text}`}
          >
            {part.text}
          </span>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        )
      )}
      {previewPath && (
        <FilePreviewModal
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  )
}
