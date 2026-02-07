import { useState, useRef, useEffect } from 'react'
import type { TerminalInstance } from '../types'
import { TerminalThumbnail } from './TerminalThumbnail'
import { getAgentPreset } from '../types/agent-presets'

interface ThumbnailBarProps {
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  onFocus: (id: string) => void
  onAddTerminal?: () => void
  onAddClaudeAgent?: () => void
  showAddButton: boolean
  height?: number
  collapsed?: boolean
  onCollapse?: () => void
}

export function ThumbnailBar({
  terminals,
  focusedTerminalId,
  onFocus,
  onAddTerminal,
  onAddClaudeAgent,
  showAddButton,
  height,
  collapsed = false,
  onCollapse
}: ThumbnailBarProps) {
  // Check if these are agent terminals or regular terminals
  const firstTerminal = terminals[0]
  const isAgentList = firstTerminal?.agentPreset && firstTerminal.agentPreset !== 'none'
  const label = isAgentList
    ? (getAgentPreset(firstTerminal.agentPreset!)?.name || 'Agent')
    : 'Terminals'

  // Collapsed state - show icon bar
  if (collapsed) {
    return (
      <div
        className="collapsed-bar collapsed-bar-bottom"
        onClick={onCollapse}
        title="Expand Thumbnails"
      >
        <div className="collapsed-bar-icon">🖼️</div>
        <span className="collapsed-bar-label">{label}</span>
      </div>
    )
  }

  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!showAddMenu) return
    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showAddMenu])

  const style = height ? { height: `${height}px`, flex: 'none' } : undefined

  return (
    <div className="thumbnail-bar" style={style}>
      <div className="thumbnail-bar-header">
        <span>{label}</span>
        <div className="thumbnail-bar-actions">
          {onAddTerminal && (
            <div className="thumbnail-add-wrapper" ref={addMenuRef}>
              <button
                className="thumbnail-add-btn"
                onClick={() => setShowAddMenu(prev => !prev)}
                title="Add Terminal or Agent"
              >
                +
              </button>
              {showAddMenu && (
                <div className="thumbnail-add-menu">
                  <div
                    className="thumbnail-add-menu-item"
                    onClick={() => { onAddTerminal(); setShowAddMenu(false) }}
                  >
                    <span className="thumbnail-add-menu-icon">⌘</span>
                    Terminal
                  </div>
                  {onAddClaudeAgent && (
                    <div
                      className="thumbnail-add-menu-item"
                      onClick={() => { onAddClaudeAgent(); setShowAddMenu(false) }}
                    >
                      <span className="thumbnail-add-menu-icon" style={{ color: '#d97706' }}>✦</span>
                      Claude Code
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {onCollapse && (
            <button className="thumbnail-collapse-btn" onClick={onCollapse} title="Collapse Panel">
              ▼
            </button>
          )}
        </div>
      </div>
      <div className="thumbnail-list">
        {terminals.map(terminal => (
          <TerminalThumbnail
            key={terminal.id}
            terminal={terminal}
            isActive={terminal.id === focusedTerminalId}
            onClick={() => onFocus(terminal.id)}
          />
        ))}
      </div>
    </div>
  )
}
