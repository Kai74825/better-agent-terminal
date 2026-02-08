import { useState, useEffect, useCallback } from 'react'
import { HighlightedCode } from './PathLinker'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileTreeProps {
  rootPath: string
}

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function getFileExt(name: string): string {
  const lower = name.toLowerCase()
  // Handle dotfiles like .gitignore, .env
  if (lower.startsWith('.') && !lower.includes('.', 1)) {
    return lower.substring(1)
  }
  return lower.split('.').pop() || ''
}

function canPreview(name: string): 'text' | 'image' | null {
  const ext = getFileExt(name)
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return null
}

function FileTreeNode({
  entry, depth, selectedPath, onSelect,
}: {
  entry: FileEntry; depth: number; selectedPath: string | null; onSelect: (entry: FileEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    if (entry.isDirectory) {
      if (expanded) {
        setExpanded(false)
        return
      }
      if (children === null) {
        setLoading(true)
        try {
          const entries = await window.electronAPI.fs.readdir(entry.path)
          setChildren(entries)
        } catch {
          setChildren([])
        }
        setLoading(false)
      }
      setExpanded(true)
    } else {
      onSelect(entry)
    }
  }, [entry, expanded, children, onSelect])

  const icon = entry.isDirectory
    ? (expanded ? '📂' : '📁')
    : getFileIcon(entry.name)

  const isSelected = !entry.isDirectory && entry.path === selectedPath

  return (
    <>
      <div
        className={`file-tree-item ${entry.isDirectory ? 'file-tree-folder' : 'file-tree-file'} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
      >
        <span className="file-tree-icon">{icon}</span>
        <span className="file-tree-name">{entry.name}</span>
        {loading && <span className="file-tree-loading">...</span>}
      </div>
      {expanded && children && children.map(child => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function getFileIcon(name: string): string {
  const ext = getFileExt(name)
  switch (ext) {
    case 'ts': case 'tsx': return '🔷'
    case 'js': case 'jsx': return '🟡'
    case 'json': return '📋'
    case 'css': case 'scss': case 'less': return '🎨'
    case 'html': case 'htm': return '🌐'
    case 'md': return '📝'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return '🖼️'
    case 'sh': case 'bash': case 'zsh': return '⚙️'
    case 'yml': case 'yaml': case 'toml': return '⚙️'
    case 'lock': return '🔒'
    case 'py': return '🐍'
    case 'go': return '🔵'
    case 'rs': return '🦀'
    default: return '📄'
  }
}

function FilePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
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

    const type = canPreview(fileName)
    if (type === 'text') {
      window.electronAPI.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
        } else {
          setContent(result.content || '')
        }
        setLoading(false)
      })
    } else if (type === 'image') {
      window.electronAPI.image.readAsDataUrl(filePath).then(url => {
        if (cancelled) return
        setImageUrl(url)
        setLoading(false)
      }).catch(() => {
        if (cancelled) return
        setError('Failed to load image')
        setLoading(false)
      })
    } else {
      setError('Preview not available for this file type')
      setLoading(false)
    }

    return () => { cancelled = true }
  }, [filePath, fileName])

  if (loading) {
    return <div className="file-preview-status">Loading...</div>
  }

  if (error) {
    return <div className="file-preview-status">{error}</div>
  }

  if (imageUrl) {
    return (
      <div className="file-preview-image">
        <img src={imageUrl} alt={fileName} />
      </div>
    )
  }

  if (content !== null) {
    return (
      <HighlightedCode code={content} ext={getFileExt(fileName)} className="file-preview-text" />
    )
  }

  return null
}

export function FileTree({ rootPath }: Readonly<FileTreeProps>) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.fs.readdir(rootPath)
      setEntries(result)
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [rootPath])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  const handleSelect = useCallback((entry: FileEntry) => {
    setSelectedFile(entry)
  }, [])

  if (loading && entries.length === 0) {
    return <div className="file-tree-empty">Loading...</div>
  }

  if (entries.length === 0) {
    return <div className="file-tree-empty">No files found</div>
  }

  return (
    <div className="file-tree-split">
      <div className="file-tree">
        <div className="file-tree-header">
          <button className="file-tree-refresh-btn" onClick={loadRoot} title="Refresh">↻</button>
        </div>
        <div className="file-tree-list">
          {entries.map(entry => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={selectedFile?.path || null}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </div>
      <div className="file-preview">
        {selectedFile ? (
          <>
            <div className="file-preview-header">
              <span className="file-preview-filename">{selectedFile.name}</span>
            </div>
            <div className="file-preview-body">
              <FilePreview filePath={selectedFile.path} fileName={selectedFile.name} />
            </div>
          </>
        ) : (
          <div className="file-preview-status">Select a file to preview</div>
        )}
      </div>
    </div>
  )
}
