import { useId } from 'react'
import { Empty, Tooltip } from 'antd'
import type { PipelineDAGEdge, PipelineDAGNode } from '@/types'

const PREVIEW_NODE_W = 228
const PREVIEW_NODE_H = 78
const FLOW_ARROW_DELAYS = ['0s', '-0.45s', '-0.9s']
const FLOW_ARROW_PATH = 'M -0.42 -1.15 L 0.62 0 L -0.42 1.15 L -0.16 0 Z'

type PreviewPoint = { x: number; y: number }
type PreviewNode = PreviewPoint & { node: PipelineDAGNode }
type PreviewEdge = { edge: PipelineDAGEdge; source: PreviewPoint; target: PreviewPoint }

interface Props {
  nodes: PipelineDAGNode[]
  edges: PipelineDAGEdge[]
  selectedNodeId?: string
  canvasActive?: boolean
  onSelectCanvas?: () => void
  onSelectNode?: (nodeId: string) => void
}

export function pipelineNodeTypeLabel(type: PipelineDAGNode['type']) {
  if (type === 'jenkins') return 'Jenkins 组件'
  if (type === 'pipeline') return '子流水线'
  if (type === 'gate') return '等待 / 汇聚'
  return '组件'
}

export function pipelineNodeTypeClass(type: PipelineDAGNode['type']) {
  if (type === 'jenkins') return 'is-jenkins'
  if (type === 'pipeline') return 'is-pipeline'
  if (type === 'gate') return 'is-gate'
  return 'is-testset'
}

export function pipelineJobName(node?: PipelineDAGNode) {
  return String(node?.config?.jobName ?? '').trim()
}

export function pipelineNodeName(node?: PipelineDAGNode) {
  if (!node) return ''
  return node.label || node.id
}

function buildPreview(nodes: PipelineDAGNode[], edges: PipelineDAGEdge[]) {
  if (!nodes.length) return { nodes: [] as PreviewNode[], edges: [] as PreviewEdge[] }
  const minX = Math.min(...nodes.map((node) => node.x ?? 0))
  const minY = Math.min(...nodes.map((node) => node.y ?? 0))
  const maxX = Math.max(...nodes.map((node) => (node.x ?? 0) + PREVIEW_NODE_W))
  const maxY = Math.max(...nodes.map((node) => (node.y ?? 0) + PREVIEW_NODE_H))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const pointMap = new Map<string, PreviewPoint>()
  const previewNodes = nodes.map((node, index) => {
    const x = 8 + ((((node.x ?? index * 260) + PREVIEW_NODE_W / 2 - minX) / width) * 84)
    const y = 12 + ((((node.y ?? index * 120) + PREVIEW_NODE_H / 2 - minY) / height) * 76)
    const point = { x: Math.max(8, Math.min(92, x)), y: Math.max(12, Math.min(88, y)) }
    pointMap.set(node.id, point)
    return { node, ...point }
  })
  const previewEdges = edges
    .map((edge) => ({ edge, source: pointMap.get(edge.source), target: pointMap.get(edge.target) }))
    .filter((item): item is PreviewEdge => !!item.source && !!item.target)
  return { nodes: previewNodes, edges: previewEdges }
}

function previewEdgePath(source: PreviewPoint, target: PreviewPoint) {
  return `M ${source.x} ${source.y} L ${target.x} ${target.y}`
}

export default function PipelineFlowPreview({
  nodes,
  edges,
  selectedNodeId,
  canvasActive,
  onSelectCanvas,
  onSelectNode,
}: Props) {
  const markerBase = useId().replace(/:/g, '')
  const waitMarkerId = `${markerBase}-trigger-arrow`
  const detachedMarkerId = `${markerBase}-trigger-arrow-detached`
  const preview = buildPreview(nodes, edges)

  return (
    <div
      className={`atop-trigger-mini-canvas${canvasActive ? ' is-active' : ''}`}
      onClick={onSelectCanvas}
    >
      {!nodes.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前流水线还没有画布组件" />
      ) : (
        <>
          <svg className="atop-trigger-mini-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id={waitMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#2563EB" />
              </marker>
              <marker id={detachedMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#BA7517" />
              </marker>
            </defs>
            {preview.edges.map(({ edge, source, target }, index) => {
              const isDetached = edge.type === 'detached'
              const key = edge.id || `${edge.source}-${edge.target}`
              const pathId = `${markerBase}-trigger-path-${index}`
              const path = previewEdgePath(source, target)
              const color = isDetached ? '#BA7517' : '#2563EB'
              return (
                <g key={key}>
                  <path
                    id={pathId}
                    d={path}
                    className={`atop-trigger-mini-edge-path${isDetached ? ' is-detached' : ''}`}
                    markerEnd={`url(#${isDetached ? detachedMarkerId : waitMarkerId})`}
                  />
                  {FLOW_ARROW_DELAYS.map((delay) => (
                    <path
                      key={delay}
                      className={`atop-trigger-mini-flow-arrow${isDetached ? ' is-detached' : ''}`}
                      d={FLOW_ARROW_PATH}
                      fill={color}
                    >
                      <animateMotion dur="1.35s" begin={delay} repeatCount="indefinite" rotate="auto">
                        <mpath href={`#${pathId}`} />
                      </animateMotion>
                    </path>
                  ))}
                </g>
              )
            })}
          </svg>
          {preview.nodes.map(({ node, x, y }) => (
            <Tooltip
              key={node.id}
              title={node.type === 'jenkins' ? (pipelineJobName(node) || '未配置 Job') : pipelineNodeTypeLabel(node.type)}
            >
              <button
                type="button"
                className={`atop-trigger-mini-node ${pipelineNodeTypeClass(node.type)}${selectedNodeId === node.id ? ' is-active' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
                aria-label={`查看${pipelineNodeName(node)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectNode?.(node.id)
                }}
              >
                <span>{pipelineNodeTypeLabel(node.type)}</span>
                <strong>{pipelineNodeName(node)}</strong>
                {node.type === 'jenkins' && <em>{pipelineJobName(node) || '未配置 Job'}</em>}
              </button>
            </Tooltip>
          ))}
        </>
      )}
    </div>
  )
}
