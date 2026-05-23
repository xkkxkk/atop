import { useState, useEffect } from 'react'
import type { TableProps } from 'antd'

interface TableLayoutOptions {
  /** 距离屏幕顶部的额外偏移量（像素），用于计算 scroll.y。默认 320 */
  offsetY?: number
}

/**
 * 统一的表格布局 Hook
 * - 表头固定（sticky），表格 body 内滚动
 * - 表格底部距页面底部 10px
 * - 不产生页面级横向滚动条
 */
export function useTableLayout({ offsetY = 320 }: TableLayoutOptions = {}) {
  const [windowHeight, setWindowHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 800)

  useEffect(() => {
    let timeoutId: number
    const handleResize = () => {
      clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        setWindowHeight(window.innerHeight)
      }, 200)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(timeoutId)
    }
  }, [])

  // 底部留 10px 间距
  const scrollY = windowHeight - offsetY - 10

  const defaultPageSize = windowHeight > 960 ? 20 : 10

  const tableProps: Pick<TableProps<any>, 'pagination' | 'scroll'> = {
    pagination: {
      defaultPageSize,
      showSizeChanger: true,
      pageSizeOptions: [10, 20, 50, 100],
      showTotal: (total: number) => `共 ${total} 条`,
      showQuickJumper: true,
    },
    scroll: {
      y: scrollY > 200 ? scrollY : 300,
      // 不设置 x，表格列自适应容器宽度，不产生页面级横向滚动
    },
  }

  return { tableProps, defaultPageSize }
}
