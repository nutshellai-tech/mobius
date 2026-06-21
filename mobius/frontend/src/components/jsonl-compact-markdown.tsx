import { useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { VSCodeOpenContext, isLikelyFilesystemPath } from './jsonl-vscode-link'

const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight as any]

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

function MarkdownTable({ children, node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div className="jsonl-compact-md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  )
}

export default function JsonlCompactMarkdown({ text }: { text: string }) {
  return (
    <div className="jsonl-compact-md px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-secondary)] select-text">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS as any}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={{
          a: MarkdownAnchor as any,
          table: MarkdownTable as any,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
