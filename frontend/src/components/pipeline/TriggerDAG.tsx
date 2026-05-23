import { useEffect, useRef, useState, useMemo } from 'react'
import { Graph } from '@antv/x6'
import { Button, Space, Tooltip, message } from 'antd'
import {
  FullscreenOutlined, FullscreenExitOutlined,
  ReloadOutlined, DisconnectOutlined,
} from '@ant-design/icons'
import type { TestSet } from '@/types'

// ── Types ────────────────────────────────────────────────────────────────
export interface DAGEdge {
  source: string
  target: string
}

interface Props {
  testSets: TestSet[]
  edges: DAGEdge[]
  onEdgesChange: (edges: DAGEdge[]) => void
  onLayersChange?: (layers: string[][]) => void
}

// ── Constants ─────────────────────────────────────────────────────────────
const NODE_W = 210
const NODE_H = 66
const H_GAP = 56
const V_GAP = 60

// ── Layer colors ──────────────────────────────────────────────────────────
const LAYER_COLORS = [
  { bg: '#EFF6FF', border: '#3B82F6', text: '#1E3A5F' },
  { bg: '#F0FDF4', border: '#22C55E', text: '#14532D' },
  { bg: '#FFFBEB', border: '#F59E0B', text: '#78350F' },
  { bg: '#FDF2F8', border: '#EC4899', text: '#831843' },
  { bg: '#F5F3FF', border: '#8B5CF6', text: '#4C1D95' },
  { bg: '#ECFDF5', border: '#10B981', text: '#064E3B' },
]
const getColor = (i: number) => LAYER_COLORS[i % LAYER_COLORS.length]

// ── Topological sort ──────────────────────────────────────────────────────
function computeLayers(nodeIds: string[], edges: DAGEdge[]): string[][] {
  const inDeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  nodeIds.forEach(id => { inDeg.set(id, 0); adj.set(id, []) })

  edges.forEach(({ source, target }) => {
    if (inDeg.has(source) && inDeg.has(target)) {
      adj.get(source)!.push(target)
      inDeg.set(target, (inDeg.get(target) || 0) + 1)
    }
  })

  const layers: string[][] = []
  let queue = nodeIds.filter(id => inDeg.get(id) === 0)
  while (queue.length > 0) {
    layers.push([...queue])
    const next: string[] = []
    queue.forEach(id => {
      adj.get(id)?.forEach(t => {
        inDeg.set(t, (inDeg.get(t) || 0) - 1)
        if (inDeg.get(t) === 0) next.push(t)
      })
    })
    queue = next
  }
  const placed = new Set(layers.flat())
  const remaining = nodeIds.filter(id => !placed.has(id))
  if (remaining.length > 0) layers.push(remaining)
  return layers
}

// ── Auto-connect: priority + depends_on ───────────────────────────────────
//
// Rule 1: Group by priority (smaller number = earlier layer).
//         Each node in priority layer N connects to every node in layer N+1,
//         UNLESS the target already has explicit depends_on.
//
// Rule 2: If a test set has depends_on (by name), those edges take precedence.
//         The depends_on edges are added regardless of priority.
//
function autoConnect(testSets: TestSet[]): DAGEdge[] {
  if (testSets.length <= 1) return []

  const nameToId = new Map<string, string>()
  const idToTs = new Map<string, TestSet>()
  testSets.forEach(ts => { nameToId.set(ts.name, ts.id); idToTs.set(ts.id, ts) })

  const edgeSet = new Set<string>()
  const edges: DAGEdge[] = []
  const addEdge = (src: string, tgt: string) => {
    const key = `${src}->${tgt}`
    if (!edgeSet.has(key) && src !== tgt) {
      edgeSet.add(key)
      edges.push({ source: src, target: tgt })
    }
  }

  // Collect IDs that have explicit depends_on
  const hasExplicitDeps = new Set<string>()
  testSets.forEach(ts => {
    if (ts.dependsOn && ts.dependsOn.length > 0) {
      hasExplicitDeps.add(ts.id)
    }
  })

  // Rule 2: explicit depends_on edges
  testSets.forEach(ts => {
    (ts.dependsOn ?? []).forEach(depName => {
      const srcId = nameToId.get(depName)
      if (srcId) addEdge(srcId, ts.id)
    })
  })

  // Rule 1: priority-based edges (only for nodes WITHOUT explicit depends_on)
  const groups = new Map<number, TestSet[]>()
  testSets.forEach(ts => {
    const p = ts.priority ?? 0
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p)!.push(ts)
  })
  const sortedP = Array.from(groups.keys()).sort((a, b) => a - b)

  if (sortedP.length > 1) {
    for (let i = 0; i < sortedP.length - 1; i++) {
      const curGroup = groups.get(sortedP[i])!
      const nextGroup = groups.get(sortedP[i + 1])!
      curGroup.forEach(src => {
        nextGroup.forEach(tgt => {
          // Only add priority edge if target has no explicit depends_on
          if (!hasExplicitDeps.has(tgt.id)) {
            addEdge(src.id, tgt.id)
          }
        })
      })
    }
  }

  return edges
}

// ── Layout ────────────────────────────────────────────────────────────────
function layoutPositions(layers: string[][], cw: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const w = Math.max(cw, 600)
  layers.forEach((layer, li) => {
    const totalW = layer.length * NODE_W + (layer.length - 1) * H_GAP
    const startX = Math.max(30, (w - totalW) / 2)
    layer.forEach((id, ni) => {
      pos.set(id, { x: startX + ni * (NODE_W + H_GAP), y: 40 + li * (NODE_H + V_GAP) })
    })
  })
  return pos
}

// ── Register node shape ───────────────────────────────────────────────────
let registered = false
function ensureRegistered() {
  if (registered) return
  registered = true
  Graph.registerNode('dag-ts-node', {
    inherit: 'rect',
    width: NODE_W, height: NODE_H,
    attrs: {
      body: { rx: 10, ry: 10, strokeWidth: 2 },
      label: { fontSize: 11, fontFamily: 'PingFang SC, -apple-system, sans-serif',
        textWrap: { width: NODE_W - 24, ellipsis: true, height: NODE_H - 16 },
        refY: 0.5, textAnchor: 'middle', textVerticalAnchor: 'middle',
      },
    },
    ports: {
      groups: {
        top:    { position: 'top',    attrs: { circle: { r: 5, magnet: true, fill: '#fff', strokeWidth: 2 } } },
        bottom: { position: 'bottom', attrs: { circle: { r: 5, magnet: true, fill: '#fff', strokeWidth: 2 } } },
      },
      items: [{ group: 'top', id: 'in' }, { group: 'bottom', id: 'out' }],
    },
  })
}

// ═════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════
export default function TriggerDAG({ testSets, edges, onEdgesChange, onLayersChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  const [isFullscreen, setIsFullscreen] = useState(false)
  const [cw, setCw] = useState(900)

  // Build lookup
  const tsMap = useMemo(() => new Map(testSets.map(ts => [ts.id, ts])), [testSets])

  // Layers
  const layers = useMemo(() => {
    const l = computeLayers(testSets.map(ts => ts.id), edges)
    onLayersChange?.(l)
    return l
  }, [testSets, edges])

  // Auto-connect on first load
  const doneRef = useRef(false)
  useEffect(() => {
    if (testSets.length > 0 && edges.length === 0 && !doneRef.current) {
      doneRef.current = true
      const auto = autoConnect(testSets)
      if (auto.length > 0) onEdgesChange(auto)
    }
    if (testSets.length === 0) doneRef.current = false
  }, [testSets])

  // Observe width
  useEffect(() => {
    if (!wrapperRef.current) return
    const obs = new ResizeObserver(entries => { for (const e of entries) setCw(e.contentRect.width) })
    obs.observe(wrapperRef.current)
    return () => obs.disconnect()
  }, [])

  // Init graph
  useEffect(() => {
    if (!containerRef.current) return
    ensureRegistered()
    const graph = new Graph({
      container: containerRef.current,
      autoResize: true,
      panning: { enabled: true },
      mousewheel: { enabled: true, zoomAtMousePosition: true, modifiers: 'ctrl' },
      connecting: {
        router: 'manhattan',
        connector: { name: 'rounded', args: { radius: 10 } },
        snap: { radius: 20 },
        allowBlank: false, allowMulti: false, allowLoop: false, allowEdge: false,
        highlight: true,
        sourceAnchor: 'bottom', targetAnchor: 'top',
        sourceConnectionPoint: 'anchor', targetConnectionPoint: 'anchor',
        createEdge: () => graph.createEdge({
          attrs: { line: { stroke: '#3B82F6', strokeWidth: 2, targetMarker: { name: 'block', width: 10, height: 8 } } },
        }),
        validateConnection({ sourceCell, targetCell }) {
          if (!sourceCell || !targetCell || sourceCell === targetCell) return false
          return !edgesRef.current.some(e => e.source === sourceCell.id && e.target === targetCell.id)
        },
      },
      interacting: { nodeMovable: true },
    })

    graph.on('edge:connected', ({ edge }) => {
      const s = edge.getSourceCellId(), t = edge.getTargetCellId()
      if (s && t) {
        const next = [...edgesRef.current, { source: s, target: t }]
        const ids = edgesRef.current.length > 0
          ? Array.from(new Set([...next.map(e => e.source), ...next.map(e => e.target)]))
          : []
        // cycle check
        const allIds = Array.from(new Set([...edgesRef.current.map(e => e.source), ...edgesRef.current.map(e => e.target), s, t]))
        const test = computeLayers(allIds, next)
        if (test.flat().length < allIds.length) {
          graph.removeEdge(edge.id)
          message.warning('检测到循环依赖，已撤销')
          return
        }
        onEdgesChange(next)
      }
    })

    graph.on('edge:contextmenu', ({ e, edge }) => {
      e.preventDefault()
      const s = edge.getSourceCellId(), t = edge.getTargetCellId()
      graph.removeEdge(edge.id)
      if (s && t) onEdgesChange(edgesRef.current.filter(e => !(e.source === s && e.target === t)))
    })

    graphRef.current = graph
    return () => { graph.dispose(); graphRef.current = null }
  }, [])

  // Sync graph
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return

    const positions = layoutPositions(layers, cw)
    const layerMap = new Map<string, number>()
    layers.forEach((layer, li) => layer.forEach(id => layerMap.set(id, li)))

    graph.freeze()
    graph.clearCells()

    // Nodes
    testSets.forEach(ts => {
      const p = positions.get(ts.id) || { x: 40, y: 40 }
      const li = layerMap.get(ts.id) ?? 0
      const c = getColor(li)
      const deps = (ts.dependsOn ?? []).length
      const skipBadge = ts.skipOnDepFailure ? '⚠' : ''
      const pBadge = ts.priority !== 0 ? `P${ts.priority}` : ''
      // Line 1: priority + name
      // Line 2: dep info
      const line1 = pBadge ? `${pBadge} · ${ts.name}` : ts.name
      const line2 = deps > 0
        ? `${skipBadge}${skipBadge ? ' ' : ''}依赖 ${deps} 项${ts.skipOnDepFailure ? '（失败跳过）' : ''}`
        : '无依赖 · 直接执行'

      graph.addNode({
        id: ts.id, shape: 'dag-ts-node', x: p.x, y: p.y,
        label: `${line1}\n${line2}`,
        attrs: {
          body: { fill: c.bg, stroke: c.border },
          label: { fill: c.text, lineHeight: 18 },
        },
        ports: {
          groups: {
            top:    { position: 'top',    attrs: { circle: { r: 5, magnet: true, stroke: c.border, fill: '#fff', strokeWidth: 2 } } },
            bottom: { position: 'bottom', attrs: { circle: { r: 5, magnet: true, stroke: c.border, fill: '#fff', strokeWidth: 2 } } },
          },
          items: [{ group: 'top', id: 'in' }, { group: 'bottom', id: 'out' }],
        },
      })
    })

    // Edges
    const nodeIds = new Set(testSets.map(ts => ts.id))
    edges.forEach(({ source, target }) => {
      if (!nodeIds.has(source) || !nodeIds.has(target)) return
      const targetTs = tsMap.get(target)
      const isSkipEdge = targetTs?.skipOnDepFailure
      graph.addEdge({
        source: { cell: source, port: 'out' },
        target: { cell: target, port: 'in' },
        attrs: {
          line: {
            stroke: isSkipEdge ? '#F59E0B' : '#3B82F6',
            strokeWidth: 2,
            strokeDasharray: isSkipEdge ? '6 3' : undefined,
            targetMarker: { name: 'block', width: 10, height: 8 },
          },
        },
        labels: isSkipEdge ? [{
          attrs: { label: { text: '失败跳过', fill: '#D97706', fontSize: 10 },
            rect: { fill: '#FFFBEB', stroke: '#F59E0B', strokeWidth: 1, rx: 3, ry: 3 } },
          position: 0.5,
        }] : [],
      })
    })

    graph.unfreeze()
    setTimeout(() => graph.centerContent(), 60)
  }, [testSets, edges, layers, cw, tsMap])

  // Fullscreen
  const toggleFs = () => {
    const el = wrapperRef.current
    if (!el) return
    if (!isFullscreen) el.requestFullscreen?.()
    else document.exitFullscreen?.()
  }
  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  const handleAutoConnect = () => {
    const auto = autoConnect(testSets)
    onEdgesChange(auto)
    message.success(`已根据优先级和依赖关系生成 ${auto.length} 条连线`)
  }

  const canvasH = isFullscreen ? '100%' : Math.max(300, layers.length * (NODE_H + V_GAP) + 100)

  return (
    <div ref={wrapperRef} style={{
      background: isFullscreen ? '#fff' : 'transparent',
      padding: isFullscreen ? 16 : 0,
      display: 'flex', flexDirection: 'column',
      height: isFullscreen ? '100vh' : 'auto',
    }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <Space size={6} wrap>
          {layers.map((layer, i) => {
            const c = getColor(i)
            return (
              <span key={i} style={{
                fontSize: 12, color: c.text, padding: '2px 10px',
                background: c.bg, borderRadius: 4, border: `1px solid ${c.border}`,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <strong>L{i}</strong>
                <span style={{ color: c.text + 'bb' }}>
                  {i === 0 ? '直接执行' : `等 L${i - 1} 完成`}
                </span>
                <span style={{ fontWeight: 600 }}>{layer.length}</span>个
              </span>
            )
          })}
        </Space>
        <Space size={4}>
          <Tooltip title="根据 priority 和 depends_on 自动生成连线">
            <Button size="small" icon={<ReloadOutlined />} onClick={handleAutoConnect}>自动连线</Button>
          </Tooltip>
          <Tooltip title="清除所有连线（全部并行执行）">
            <Button size="small" icon={<DisconnectOutlined />} onClick={() => onEdgesChange([])}>清除连线</Button>
          </Tooltip>
          <Tooltip title={isFullscreen ? '退出全屏' : '全屏编排'}>
            <Button size="small" type={isFullscreen ? 'primary' : 'default'}
              icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFs}>{isFullscreen ? '退出全屏' : '全屏'}</Button>
          </Tooltip>
        </Space>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#9C9A92', marginBottom: 6, flexWrap: 'wrap' }}>
        <span>拖拽节点调整位置 · 下方端口→上方端口建立依赖 · 右键连线删除 · Ctrl+滚轮缩放</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 20, height: 2, background: '#3B82F6', display: 'inline-block' }} /> 正常依赖
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 20, height: 0, borderTop: '2px dashed #F59E0B', display: 'inline-block' }} /> 失败跳过
        </span>
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{
        width: '100%',
        flex: isFullscreen ? 1 : undefined,
        height: isFullscreen ? undefined : canvasH,
        minHeight: 300, border: '1px solid #e8e8e5', borderRadius: 8, background: '#FAFAF8',
      }} />
    </div>
  )
}

export { computeLayers, autoConnect }
