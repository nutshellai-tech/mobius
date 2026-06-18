import { useContext, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { VSCodeOpenContext, isLikelyFilesystemPath } from './jsonl-vscode-link'

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const ctx = useContext(VSCodeOpenContext)
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href || !ctx || !isLikelyFilesystemPath(href)) return
    const url = ctx.openLocalPath(href)
    if (!url) return // meta not ready yet → let default happen this once
    e.preventDefault()
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  return <a href={href} target="_blank" rel="noreferrer" onClick={onClick}>{children}</a>
}

export default function JsonlCompactMarkdown({ text }: { text: string }) {
  return (
    <div className="jsonl-compact-md px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-secondary)] select-text">
      <ReactMarkdown
        rehypePlugins={[rehypeHighlight as any]}
        components={{
          a: MarkdownAnchor as any,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
