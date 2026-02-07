import { useState, useEffect, useCallback } from 'react'

interface GitCommit {
  hash: string
  author: string
  date: string
  message: string
}

interface GitStatusEntry {
  status: string
  file: string
}

interface GitPanelProps {
  workspaceFolderPath: string
}

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log',
])

function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTS.has(ext)
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 30) return `${diffDays}d ago`
    return d.toLocaleDateString()
  } catch {
    return dateStr
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'M': return '#d97706'
    case 'A': case '??': return '#4ec9b0'
    case 'D': return '#f44336'
    case 'R': return '#569cd6'
    default: return 'var(--text-secondary)'
  }
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return <div className="git-diff-empty">Select a file to view diff</div>
  }

  const lines = diff.split('\n')

  return (
    <pre className="git-diff-content">
      {lines.map((line, i) => {
        let className = 'git-diff-line'
        if (line.startsWith('+') && !line.startsWith('+++')) {
          className += ' git-diff-add'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className += ' git-diff-del'
        } else if (line.startsWith('@@')) {
          className += ' git-diff-hunk'
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          className += ' git-diff-header'
        }
        return <div key={i} className={className}>{line || ' '}</div>
      })}
    </pre>
  )
}

export function GitPanel({ workspaceFolderPath }: Readonly<GitPanelProps>) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [status, setStatus] = useState<GitStatusEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [changedFiles, setChangedFiles] = useState<GitStatusEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'diff' | 'file'>('diff')
  const [loading, setLoading] = useState(true)
  const [filesLoading, setFilesLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    setSelectedCommit(null)
    setChangedFiles([])
    setSelectedFile(null)
    setDiff('')
    try {
      const [logResult, statusResult, branch] = await Promise.all([
        window.electronAPI.git.getLog(workspaceFolderPath),
        window.electronAPI.git.getStatus(workspaceFolderPath),
        window.electronAPI.git.getBranch(workspaceFolderPath),
      ])
      setIsGitRepo(branch !== null)
      setCommits(logResult)
      setStatus(statusResult)
    } catch {
      setIsGitRepo(false)
    }
    setLoading(false)
  }, [workspaceFolderPath])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSelectCommit = useCallback(async (hash: string) => {
    setSelectedCommit(hash)
    setSelectedFile(null)
    setDiff('')
    setFilesLoading(true)
    try {
      if (hash === 'working') {
        setChangedFiles(status)
      } else {
        const files = await window.electronAPI.git.getDiffFiles(workspaceFolderPath, hash)
        setChangedFiles(files)
      }
    } catch {
      setChangedFiles([])
    }
    setFilesLoading(false)
  }, [workspaceFolderPath, status])

  const handleSelectFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setViewMode('diff')
    setFileContent(null)
    setDiffLoading(true)
    try {
      const d = await window.electronAPI.git.getDiff(workspaceFolderPath, selectedCommit || undefined, filePath)
      if (d.trim()) {
        setDiff(d)
      } else {
        // For untracked/new files, git diff returns empty - read file content directly
        const fileEntry = changedFiles.find(f => f.file === filePath)
        if (fileEntry && (fileEntry.status === '??' || fileEntry.status === 'A')) {
          const fullPath = workspaceFolderPath + '\\' + filePath.replace(/\//g, '\\')
          const result = await window.electronAPI.fs.readFile(fullPath)
          if (result.content) {
            const lines = result.content.split('\n').map(l => '+' + l).join('\n')
            setDiff(`diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${result.content.split('\n').length} @@\n${lines}`)
          } else {
            setDiff(result.error || '')
          }
        } else {
          setDiff('')
        }
      }
    } catch {
      setDiff('')
    }
    setDiffLoading(false)
  }, [workspaceFolderPath, selectedCommit, changedFiles])

  const handleViewFile = useCallback(async () => {
    if (!selectedFile) return
    setViewMode('file')
    if (fileContent !== null) return // already loaded
    const fullPath = workspaceFolderPath + '\\' + selectedFile.replace(/\//g, '\\')
    const result = await window.electronAPI.fs.readFile(fullPath)
    setFileContent(result.content || result.error || 'Unable to read file')
  }, [selectedFile, fileContent, workspaceFolderPath])

  if (loading) {
    return <div className="git-panel-empty">Loading...</div>
  }

  if (!isGitRepo) {
    return <div className="git-panel-empty">Not a git repository</div>
  }

  return (
    <div className="git-panel">
      {/* Column 1: Commit log */}
      <div className="git-commit-list">
        <div className="git-col-header">
          <span>Commits</span>
          <button className="git-refresh-btn" onClick={loadData} title="Refresh">↻</button>
        </div>
        <div className="git-commit-list-items">
          {status.length > 0 && (
            <div
              className={`git-commit-item ${selectedCommit === 'working' ? 'active' : ''}`}
              onClick={() => handleSelectCommit('working')}
            >
              <div className="git-commit-message">
                <span className="git-uncommitted-badge">●</span>
                Uncommitted Changes
              </div>
              <div className="git-commit-meta">
                {status.length} file{status.length !== 1 ? 's' : ''} changed
              </div>
            </div>
          )}
          {commits.map(commit => (
            <div
              key={commit.hash}
              className={`git-commit-item ${selectedCommit === commit.hash ? 'active' : ''}`}
              onClick={() => handleSelectCommit(commit.hash)}
            >
              <div className="git-commit-message">{commit.message}</div>
              <div className="git-commit-meta">
                <span className="git-commit-hash">{commit.hash.substring(0, 7)}</span>
                <span className="git-commit-author">{commit.author}</span>
                <span className="git-commit-date">{formatDate(commit.date)}</span>
              </div>
            </div>
          ))}
          {commits.length === 0 && status.length === 0 && (
            <div className="git-panel-empty">No commits yet</div>
          )}
        </div>
      </div>

      {/* Column 2: Changed files */}
      <div className="git-file-list">
        <div className="git-col-header">
          <span>Files</span>
          {changedFiles.length > 0 && (
            <span className="git-file-count">{changedFiles.length}</span>
          )}
        </div>
        <div className="git-file-list-items">
          {!selectedCommit && (
            <div className="git-col-placeholder">Select a commit</div>
          )}
          {selectedCommit && filesLoading && (
            <div className="git-col-placeholder">Loading...</div>
          )}
          {selectedCommit && !filesLoading && changedFiles.length === 0 && (
            <div className="git-col-placeholder">No changed files</div>
          )}
          {changedFiles.map(f => (
            <div
              key={f.file}
              className={`git-file-item ${selectedFile === f.file ? 'active' : ''}`}
              onClick={() => handleSelectFile(f.file)}
            >
              <span className="git-file-status" style={{ color: statusColor(f.status) }}>
                {f.status}
              </span>
              <span className="git-file-name" title={f.file}>
                {f.file.split('/').pop()}
              </span>
              <span className="git-file-path" title={f.file}>
                {f.file.includes('/') ? f.file.substring(0, f.file.lastIndexOf('/') + 1) : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Column 3: Diff / File preview */}
      <div className="git-diff-view">
        {selectedFile && isTextFile(selectedFile.split('/').pop() || '') && (
          <div className="git-diff-mode-bar">
            <button
              className={`git-diff-mode-btn ${viewMode === 'diff' ? 'active' : ''}`}
              onClick={() => setViewMode('diff')}
            >
              Diff
            </button>
            <button
              className={`git-diff-mode-btn ${viewMode === 'file' ? 'active' : ''}`}
              onClick={handleViewFile}
            >
              File
            </button>
          </div>
        )}
        {diffLoading ? (
          <div className="git-diff-empty">Loading...</div>
        ) : viewMode === 'file' && fileContent !== null ? (
          <pre className="git-file-content">{fileContent}</pre>
        ) : (
          <DiffView diff={diff} />
        )}
      </div>
    </div>
  )
}
