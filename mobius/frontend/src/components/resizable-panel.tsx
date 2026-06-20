import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// 移动端断点: 与 index.css 里的 @media (max-width: 768px) 保持一致.
// 侧栏在窄屏下从「固定像素宽度 + 可拖拽」切换为「全宽纵向堆叠 + 不可拖拽」,
// 否则在 375px 宽的手机上侧栏会吃掉大半屏幕, 主内容被挤没.
const MOBILE_BREAKPOINT = 768

function useIsMobile() {
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    // 旧版 Safari 兜底
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [])
  return mobile
}

// 通用可拖拽宽度面板. 用法:
//   <ResizablePanel storageKey="..." defaultWidth={288} minWidth={200} maxWidth={480} side="left">
//     ...内容...
//   </ResizablePanel>
//
// 行为:
// - 初始宽度从 localStorage 读取 (clamp 到 [min,max]); 否则用 defaultWidth
// - side='left' 时拖拽手柄贴右边, side='right' 时贴左边
// - mousedown 进入拖拽: document 上挂 mousemove/mouseup, 拖拽期间 body 样式锁定
// - 双击手柄 reset 到 defaultWidth
// - mousemove 期间以 requestAnimationFrame 节流写入 React state, localStorage debounce 100ms
type Side = 'left' | 'right'

type ResizablePanelProps = {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  side?: Side
  className?: string
  style?: CSSProperties
  'data-tour'?: string
  children: ReactNode
}

function clampWidth(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function readStoredWidth(storageKey: string, fallback: number, min: number, max: number) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    const parsed = Number(raw)
    return clampWidth(parsed, min, max)
  } catch (_) {
    return fallback
  }
}

export function ResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side = 'left',
  className,
  style,
  'data-tour': dataTour,
  children,
}: ResizablePanelProps) {
  const [width, setWidth] = useState<number>(() => readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))
  // 窄屏下不再使用固定宽度: 整个侧栏全宽堆叠在主内容之上 (配合 index.css 的 :has 规则把
  // 父级 flex 行改成纵向), 拖拽手柄在触屏上无意义故不渲染.
  const isMobile = useIsMobile()
  const dragStateRef = useRef<{
    startX: number
    startWidth: number
    raf: number | null
    lastPersist: number
    pendingPersist: number | null
  } | null>(null)

  // storageKey 变化时重新读取 (例如切换页面但仍想保留各自的偏好)
  useEffect(() => {
    setWidth(readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))
    // 故意不把 defaultWidth/min/max 放进 deps, 避免父组件每次 render 都 reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const persistWidth = useCallback((next: number) => {
    try {
      localStorage.setItem(storageKey, String(next))
    } catch (_) {
      /* localStorage 可能不可用 (隐私模式 / 配额满) — 静默忽略 */
    }
  }, [storageKey])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current
    if (!drag) return
    e.preventDefault()
    const delta = e.clientX - drag.startX
    // side='left': 拖向右 (delta>0) 增宽; side='right': 拖向左 (delta<0) 增宽
    const candidate = side === 'left' ? drag.startWidth + delta : drag.startWidth - delta
    const next = clampWidth(candidate, minWidth, maxWidth)
    if (drag.raf !== null) cancelAnimationFrame(drag.raf)
    drag.raf = requestAnimationFrame(() => {
      setWidth(next)
      const now = Date.now()
      if (now - drag.lastPersist > 100) {
        persistWidth(next)
        drag.lastPersist = now
      } else if (drag.pendingPersist === null) {
        drag.pendingPersist = window.setTimeout(() => {
          persistWidth(next)
          if (dragStateRef.current) dragStateRef.current.pendingPersist = null
        }, 150) as unknown as number
      }
    })
  }, [minWidth, maxWidth, side, persistWidth])

  const handleMouseUp = useCallback(() => {
    const drag = dragStateRef.current
    if (!drag) return
    if (drag.raf !== null) cancelAnimationFrame(drag.raf)
    if (drag.pendingPersist !== null) {
      clearTimeout(drag.pendingPersist)
      // 收尾再 persist 一次, 保证最后的宽度落地
      setWidth((w) => { persistWidth(w); return w })
    }
    dragStateRef.current = null
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.body.classList.remove('mobius-resizing')
  }, [handleMouseMove, persistWidth])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragStateRef.current = {
      startX: e.clientX,
      startWidth: width,
      raf: null,
      lastPersist: 0,
      pendingPersist: null,
    }
    document.body.classList.add('mobius-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width, handleMouseMove, handleMouseUp])

  const handleDoubleClick = useCallback(() => {
    setWidth(defaultWidth)
    persistWidth(defaultWidth)
  }, [defaultWidth, persistWidth])

  // 卸载时清理 (避免拖到一半组件被卸载残留监听器)
  useEffect(() => {
    return () => {
      if (dragStateRef.current) {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.classList.remove('mobius-resizing')
      }
    }
  }, [handleMouseMove, handleMouseUp])

  const handleStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    [side === 'left' ? 'right' : 'left']: -2,
    width: 4,
    cursor: 'col-resize',
    zIndex: 10,
    transition: 'background-color .15s ease',
  }
  const handleClass = 'mobius-resizable-handle'
  // mobius-resizable 是给 index.css 媒体查询用的稳定锚点类; --mobile 修饰窄屏堆叠态.
  const asideClass = [
    'mobius-resizable',
    isMobile ? 'mobius-resizable--mobile' : '',
    className || '',
  ].filter(Boolean).join(' ')
  const innerStyle: CSSProperties = isMobile
    ? {
        // 全宽堆叠: 不再用固定像素宽度, 也不阻止收缩.
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        flexShrink: 1,
        position: 'relative',
        ...style,
      }
    : {
        width,
        minWidth,
        maxWidth,
        flexShrink: 0,
        position: 'relative',
        ...style,
      }

  return (
    <aside
      data-tour={dataTour}
      className={asideClass}
      style={innerStyle}
    >
      {children}
      {!isMobile && (
        <div
          className={handleClass}
          style={handleStyle}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          title="拖拽调整宽度 · 双击恢复默认"
        />
      )}
    </aside>
  )
}
