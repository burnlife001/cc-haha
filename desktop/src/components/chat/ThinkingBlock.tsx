import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

const PREVIEW_LINE_LIMIT = 10

export function ThinkingBlock({ content, isActive = false }: { content: string; isActive?: boolean }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0
  const displayLines = useMemo(() => displayContent.split('\n'), [displayContent])
  const previewContent = useMemo(
    () => displayLines.slice(0, PREVIEW_LINE_LIMIT).join('\n'),
    [displayLines],
  )
  const isPreviewTruncated = displayLines.length > PREVIEW_LINE_LIMIT

  useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayContent, expanded, isActive])

  return (
    <div className="mb-1">
      <style>{thinkingStyles}</style>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
      >
        <span className="text-[10px] text-[var(--color-outline)]">
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        <span className="shrink-0 font-medium italic">
          {t('thinking.label')}
          {isActive && <span className="thinking-dots" />}
        </span>
      </button>
      {hasDisplayContent && (
        <div
          ref={expanded ? contentRef : undefined}
          data-thinking-content={expanded ? 'expanded' : 'collapsed'}
          data-thinking-truncated={!expanded && isPreviewTruncated ? 'true' : undefined}
          onClick={!expanded ? () => setExpanded(true) : undefined}
          className={`relative mt-1 rounded-lg border border-[var(--color-border)]/40 bg-[var(--color-surface-container-lowest)] p-2.5 text-[11px] text-[var(--color-text-secondary)] ${
            expanded
              ? 'max-h-[300px] overflow-y-auto'
              : 'thinking-preview-clamp cursor-pointer'
          }`}
        >
          <MarkdownRenderer
            content={expanded ? displayContent : previewContent}
            variant="compact"
            cache={!isActive}
            streaming={isActive}
            className="thinking-markdown text-[var(--color-text-secondary)]"
          />
          {!expanded && isPreviewTruncated && <span className="thinking-preview-fade" aria-hidden="true" />}
          {isActive && (
            <span className={expanded ? 'thinking-cursor' : 'thinking-inline-cursor thinking-preview-active-cursor'} />
          )}
        </div>
      )}
    </div>
  )
}

const thinkingStyles = `
@keyframes thinking-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes thinking-dots {
  0%, 20% { content: ''; }
  40% { content: '.'; }
  60% { content: '..'; }
  80%, 100% { content: '...'; }
}
.thinking-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--color-text-tertiary);
  vertical-align: middle;
  margin-left: 1px;
  animation: thinking-cursor-blink 1s step-end infinite;
}
.thinking-inline-cursor {
  display: inline-block;
  width: 1px;
  height: 0.95em;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--color-text-tertiary);
  animation: thinking-cursor-blink 1s step-end infinite;
}
.thinking-dots::after {
  content: '';
  animation: thinking-dots 1.4s steps(1, end) infinite;
}
.thinking-markdown > :first-child,
.thinking-markdown > :first-child > :first-child {
  margin-top: 0;
}
.thinking-markdown > :last-child,
.thinking-markdown > :last-child > :last-child {
  margin-bottom: 0;
}
.thinking-preview-clamp {
  max-height: calc(${PREVIEW_LINE_LIMIT} * 1.25rem + 1.25rem);
  overflow: hidden;
}
.thinking-preview-fade {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.75rem;
  border-bottom-left-radius: 0.5rem;
  border-bottom-right-radius: 0.5rem;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--color-surface-container-lowest));
}
.thinking-preview-active-cursor {
  position: absolute;
  right: 0.6rem;
  bottom: 0.45rem;
}
`
