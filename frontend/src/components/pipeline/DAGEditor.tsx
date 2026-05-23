import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Graph, Shape } from '@antv/x6'
import type { FormInstance } from 'antd'
import {
  Alert, Button, Divider, Empty, Form, Input, Modal, Radio, Select, Space, Tag,
  Tooltip, message,
} from 'antd'
import {
  ApartmentOutlined, BranchesOutlined, CheckCircleOutlined, CompressOutlined,
  DeleteOutlined, FieldBinaryOutlined, FullscreenExitOutlined,
  FullscreenOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PlusOutlined,
  PushpinOutlined, SettingOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import type {
  PipelineDAGConfig,
  PipelineDAGEdge,
  PipelineDAGNode,
  PipelineDesignerComponent,
  PipelineDesignerComponentType,
} from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

type Option = { label: string; value: string }
type EdgeType = 'wait' | 'detached'
type SelectedCell = { kind: 'node' | 'edge'; id: string } | null
type HoverTip = { x: number; y: number; title: string; description: string } | null
type CanvasContextMenu = { x: number; y: number; kind: 'node' | 'edge' | 'selection' | 'blank'; cellId?: string } | null
type FlowDirectionKey = 'lr' | 'rl' | 'tb' | 'bt'
type FlowDirectionMeta = {
  key: FlowDirectionKey
  label: string
  summary: string
  description: string
}

const NODE_W = 228
const NODE_H = 78
const GAP_X = 42
const GAP_Y = 34
const MIN_CANVAS_HEIGHT = 620
const RUNTIME_COMPONENTS: PipelineDesignerComponentType[] = ['jenkins', 'pipeline', 'gate']
const FLOW_DIRECTION_META: Record<FlowDirectionKey, FlowDirectionMeta> = {
  lr: {
    key: 'lr',
    label: '\u4ece\u5de6\u5230\u53f3',
    summary: '\u5165\u53e3\u5728\u5de6\uff0c\u4e0b\u6e38\u5411\u53f3\u5c55\u5f00',
    description: '\u5f53\u524d\u753b\u5e03\u4e3b\u6d41\u5411\u504f\u6a2a\u5411\uff0c\u53ef\u4ee5\u987a\u7740\u53f3\u4fa7\u7ee7\u7eed\u8ffd\u8e2a\u540e\u7eed\u4efb\u52a1\u3002',
  },
  rl: {
    key: 'rl',
    label: '\u4ece\u53f3\u5230\u5de6',
    summary: '\u5165\u53e3\u5728\u53f3\uff0c\u4e0b\u6e38\u5411\u5de6\u56de\u6536',
    description: '\u5f53\u524d\u753b\u5e03\u4e3b\u6d41\u5411\u504f\u53cd\u5411\u6a2a\u5411\uff0c\u5efa\u8bae\u987a\u7740\u5de6\u4fa7\u9605\u8bfb\u540e\u7eed\u4f9d\u8d56\u3002',
  },
  tb: {
    key: 'tb',
    label: '\u4ece\u4e0a\u5230\u4e0b',
    summary: '\u5165\u53e3\u5728\u4e0a\uff0c\u4e0b\u6e38\u5411\u4e0b\u63a8\u8fdb',
    description: '\u5f53\u524d\u753b\u5e03\u4e3b\u6d41\u5411\u504f\u7eb5\u5411\uff0c\u9002\u5408\u4ece\u4e0a\u5230\u4e0b\u9010\u5c42\u67e5\u770b\u6267\u884c\u94fe\u8def\u3002',
  },
  bt: {
    key: 'bt',
    label: '\u4ece\u4e0b\u5230\u4e0a',
    summary: '\u5165\u53e3\u5728\u4e0b\uff0c\u4e0b\u6e38\u5411\u4e0a\u63a8\u8fdb',
    description: '\u5f53\u524d\u753b\u5e03\u4e3b\u6d41\u5411\u504f\u53cd\u5411\u7eb5\u5411\uff0c\u5efa\u8bae\u987a\u7740\u4e0a\u65b9\u67e5\u770b\u540e\u7eed\u8282\u70b9\u3002',
  },
}

const COMPONENT_META: Record<PipelineDesignerComponentType, {
  title: string
  desc: string
  kind: 'runtime'
  color: string
  bg: string
  icon: string
}> = {
  jenkins: {
    title: 'Jenkins 组件',
    desc: '配置 Job、参数和输出',
    kind: 'runtime',
    color: '#2563EB',
    bg: '#EFF6FF',
    icon: 'JOB',
  },
  pipeline: {
    title: '子流水线',
    desc: '复用另一条流水线',
    kind: 'runtime',
    color: '#0F6E56',
    bg: '#EAF7F1',
    icon: 'SUB',
  },
  gate: {
    title: '等待/汇聚',
    desc: '并行汇聚为 Join',
    kind: 'runtime',
    color: '#45536A',
    bg: '#F5F7FB',
    icon: 'JOIN',
  },
}

interface Props {
  pipelineId?: string
  value?: PipelineDAGConfig
  onChange?: (cfg: PipelineDAGConfig) => void
  form: FormInstance
  jenkinsOptions: Option[]
  projectOptions: Option[]
  environmentOptions: Option[]
  productOptions: Option[]
  osOptions: Option[]
  runTypeOptions: Option[]
  triggerType: string
  setTriggerType: (v: string) => void
  cronPreset: string
  setCronPreset: (v: string) => void
  cronPresets: Option[]
  readonly?: boolean
}

let shapesRegistered = false

function isRuntime(type: PipelineDesignerComponentType) {
  return RUNTIME_COMPONENTS.includes(type)
}

function runtimeDAGType(type: PipelineDesignerComponentType): PipelineDAGNode['type'] {
  if (type === 'pipeline') return 'pipeline'
  if (type === 'gate') return 'gate'
  return 'jenkins'
}

function componentTypeFromDAG(type: PipelineDAGNode['type']): PipelineDesignerComponentType {
  if (type === 'pipeline') return 'pipeline'
  if (type === 'gate') return 'gate'
  return 'jenkins'
}

function edgeLabel(type: EdgeType) {
  return type === 'detached' ? '异步启动' : '等待完成'
}

function edgeColor(type: EdgeType) {
  return type === 'detached' ? '#BA7517' : '#2563EB'
}

function edgeTextColor(type: EdgeType) {
  return type === 'detached' ? '#854F0B' : '#185FA5'
}

function edgeAttrs(type: EdgeType) {
  return {
    line: {
      class: 'atop-dag-edge-line',
      stroke: edgeColor(type),
      strokeWidth: 2,
      strokeDasharray: type === 'detached' ? '7 5' : '12 10',
      strokeDashoffset: 0,
      targetMarker: { name: 'block', width: 14, height: 10 },
    },
  }
}

function edgeHoverAttrs(type: EdgeType) {
  return {
    line: {
      class: 'atop-dag-edge-line',
      stroke: type === 'detached' ? '#D97706' : '#1D4ED8',
      strokeWidth: 5,
      strokeDasharray: type === 'detached' ? '7 5' : '12 10',
      strokeDashoffset: 0,
      targetMarker: { name: 'block', width: 16, height: 12 },
    },
  }
}

function edgeLabels(type: EdgeType) {
  const color = edgeColor(type)
  const arrowClass = `atop-dag-flow-arrow ${type === 'detached' ? 'is-detached' : 'is-wait'}`
  const flowArrows = [0.24, 0.76].map((distance, index) => ({
    markup: [{ tagName: 'path', selector: 'arrow' }],
    position: {
      distance,
      options: { keepGradient: true },
    },
    attrs: {
      arrow: {
        class: `${arrowClass} is-step-${index + 1}`,
        d: 'M -8 -5 L 8 0 L -8 5 L -3 0 Z',
        fill: color,
        stroke: '#FFFFFF',
        strokeWidth: 1.2,
        pointerEvents: 'none',
      },
    },
  }))

  return [
    ...flowArrows,
    {
      position: 0.5,
      attrs: {
        rect: { fill: '#fff', stroke: color, rx: 6, ry: 6 },
        text: { text: edgeLabel(type), fontSize: 11, fontWeight: 700, fill: edgeTextColor(type) },
      },
    },
  ]
}

function ensureShapes() {
  if (shapesRegistered) return
  shapesRegistered = true
  Graph.registerNode('pipeline-builder-node', {
    inherit: 'rect',
    width: NODE_W,
    height: NODE_H,
    attrs: {
      body: { rx: 8, ry: 8, strokeWidth: 2 },
      label: {
        fontSize: 12,
        fontWeight: 800,
        fontFamily: 'HarmonyOS Sans SC, MiSans, PingFang SC, sans-serif',
        textWrap: { width: 188, height: 44, ellipsis: true },
      },
    },
    ports: {
      groups: {
        top: {
          position: 'top',
          attrs: { circle: { r: 5, magnet: 'passive', fill: '#fff', stroke: '#8A94A7', strokeWidth: 2 } },
        },
        bottom: {
          position: 'bottom',
          attrs: { circle: { r: 5, magnet: true, fill: '#E6F1FB', stroke: '#2563EB', strokeWidth: 2 } },
        },
      },
      items: [{ id: 'top', group: 'top' }, { id: 'bottom', group: 'bottom' }],
    },
  }, true)
}

function makeEdge(type: EdgeType = 'wait') {
  return new Shape.Edge({
    attrs: edgeAttrs(type),
    labels: edgeLabels(type),
    data: { type },
    zIndex: 0,
  })
}

function applyEdgeType(edge: any, type: EdgeType) {
  edge.setData({ ...(edge.getData() ?? {}), type })
  edge.setAttrs(edgeAttrs(type))
  edge.setLabels(edgeLabels(type))
}

function nodeLabel(component: PipelineDesignerComponent) {
  const meta = COMPONENT_META[component.type]
  return `${meta.icon}  ${component.label || meta.title}`
}

function runtimeNodeFromComponent(component: PipelineDesignerComponent, dependsOn: string[]): PipelineDAGNode {
  return {
    id: component.id,
    type: runtimeDAGType(component.type),
    refId: component.refId,
    label: component.label,
    dependsOn,
    x: component.x,
    y: component.y,
    joinPolicy: component.joinPolicy ?? 'all',
    failurePolicy: component.failurePolicy ?? 'block',
    paramMapping: component.paramMapping,
    inputMapping: component.inputMapping,
    requiredOutputs: component.requiredOutputs,
    config: component.config,
  }
}

function loadComponents(value?: PipelineDAGConfig): PipelineDesignerComponent[] {
  if (value?.designer?.components?.length) {
    return value.designer.components
      .filter(item => isRuntime(item.type))
      .map(item => ({ ...item, type: componentTypeFromDAG(runtimeDAGType(item.type)) }))
  }
  return (value?.nodes ?? []).map(node => ({
    id: node.id,
    type: componentTypeFromDAG(node.type),
    label: node.label,
    x: node.x,
    y: node.y,
    refId: node.refId,
    config: node.config,
    joinPolicy: node.joinPolicy,
    failurePolicy: node.failurePolicy,
    paramMapping: node.paramMapping,
    inputMapping: node.inputMapping,
    requiredOutputs: node.requiredOutputs,
  }) satisfies PipelineDesignerComponent)
}

function graphToConfig(graph: Graph): PipelineDAGConfig {
  const components: PipelineDesignerComponent[] = graph.getNodes().map(node => {
    const pos = node.getPosition()
    const data = node.getData() as PipelineDesignerComponent
    return { ...data, x: Math.round(pos.x), y: Math.round(pos.y) }
  }).filter(component => isRuntime(component.type))
  const componentMap = new Map(components.map(item => [item.id, item]))
  const designerEdges: PipelineDAGEdge[] = graph.getEdges().map(edge => {
    const data = edge.getData() as { type?: EdgeType }
    return {
      id: edge.id,
      source: String(edge.getSourceCellId() ?? ''),
      target: String(edge.getTargetCellId() ?? ''),
      type: (data?.type === 'detached' ? 'detached' : 'wait') as EdgeType,
    }
  }).filter(edge => edge.source && edge.target && componentMap.has(edge.source) && componentMap.has(edge.target))

  const runtimeNodes = components.map(component => runtimeNodeFromComponent(
    component,
    designerEdges.filter(edge => edge.target === component.id).map(edge => edge.source),
  ))

  return {
    nodes: runtimeNodes,
    edges: designerEdges,
    designer: {
      components,
      edges: designerEdges,
    },
  }
}

function loadGraph(graph: Graph, value?: PipelineDAGConfig) {
  graph.clearCells()
  const components = loadComponents(value)
  components.forEach(component => {
    const meta = COMPONENT_META[component.type]
    graph.addNode({
      id: component.id,
      shape: 'pipeline-builder-node',
      x: component.x ?? 80,
      y: component.y ?? 80,
      label: nodeLabel(component),
      data: component,
      attrs: {
        body: { fill: meta.bg, stroke: meta.color },
        label: { fill: meta.color },
      },
    })
  })
  const componentIds = new Set(components.map(item => item.id))
  const edges = value?.designer?.edges?.length ? value.designer.edges : value?.edges ?? []
  edges.forEach(edge => {
    if (!edge.source || !edge.target || !componentIds.has(edge.source) || !componentIds.has(edge.target)) return
    const type = edge.type === 'detached' ? 'detached' : 'wait'
    graph.addEdge({
      id: edge.id || `edge-${edge.source}-${edge.target}`,
      source: { cell: edge.source, port: 'bottom' },
      target: { cell: edge.target, port: 'top' },
      attrs: edgeAttrs(type),
      labels: edgeLabels(type),
      data: { type },
      zIndex: 0,
    })
  })
}

function PairMapping({
  value = {},
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value?: Record<string, string>
  onChange: (v: Record<string, string>) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  const valueKey = JSON.stringify(value ?? {})
  const [pairs, setPairs] = useState<Array<{ key: string; value: string }>>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setPairs(Object.entries(value ?? {}).map(([key, val]) => ({ key, value: val })))
  }, [valueKey])

  const emit = (next: Array<{ key: string; value: string }>) => {
    setPairs(next)
    const map: Record<string, string> = {}
    next.forEach(pair => {
      const key = pair.key.trim()
      const val = pair.value.trim()
      if (key && val) map[key] = val
    })
    onChange(map)
  }

  const updatePair = (index: number, patch: Partial<{ key: string; value: string }>) => {
    const next = [...pairs]
    next[index] = { ...next[index], ...patch }
    emit(next)
  }

  const presets = [
    { label: '运行参数 tag', value: '${runtime.tag}' },
    { label: '上游输出 tag', value: '${nodes.上游ID.outputs.tag}' },
    { label: '上游入参 BRANCH', value: '${nodes.上游ID.inputs.BRANCH}' },
  ]
  const previewPairs = pairs.filter(pair => pair.key.trim() || pair.value.trim()).slice(0, 3)

  return (
    <div className="atop-dag-mapping-list">
      <div className="atop-dag-mapping-summary">
        <div>
          <strong>Jenkins 参数映射</strong>
          <span>{pairs.length ? `${pairs.length} 个参数会在触发时写入 Jenkins` : '未配置时，仅自动传递同名运行参数和系统变量'}</span>
        </div>
        <Button size="small" type="primary" ghost onClick={() => setOpen(true)}>
          {pairs.length ? '编辑映射' : '配置映射'}
        </Button>
      </div>
      {previewPairs.length ? (
        <div className="atop-dag-mapping-preview">
          {previewPairs.map((pair, index) => (
            <div key={`${index}-${pair.key || pair.value}`}>
              <span>{pair.key || '\u672a\u547d\u540d\u53c2\u6570'}</span>
              <code>{pair.value || '-'}</code>
            </div>
          ))}
          {pairs.length > previewPairs.length && <small>还有 {pairs.length - previewPairs.length} 条映射...</small>}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂未配置参数映射" />
      )}
      <Modal
        title="配置 Jenkins 参数映射"
        open={open}
        width={780}
        destroyOnClose={false}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="add" icon={<PlusOutlined />} onClick={() => emit([...pairs, { key: '', value: '' }])}>
            添加参数
          </Button>,
          <Button key="done" type="primary" onClick={() => setOpen(false)}>
            完成
          </Button>,
        ]}
      >
        <div className="atop-dag-mapping-modal">
          <div className="atop-dag-mapping-note">
            <strong>{'\u76ee\u6807\u53c2\u6570'}</strong>{' \u5bf9\u5e94 Jenkins Job \u4e2d\u5b9e\u9645\u5b58\u5728\u7684\u53c2\u6570\u540d\uff1b'}<strong>{'\u6765\u6e90\u8868\u8fbe\u5f0f'}</strong>{' \u53ef\u586b\u56fa\u5b9a\u503c\u3001\u8fd0\u884c\u53c2\u6570\u6216\u4e0a\u6e38 outputs/inputs\u3002'}</div>
          {pairs.length ? pairs.map((pair, index) => (
            <div className="atop-dag-mapping-row" key={`mapping-${index}`}>
              <div className="atop-dag-mapping-index">{index + 1}</div>
              <div className="atop-dag-mapping-field">
                <span>目标 Jenkins 参数</span>
                <Input
                  placeholder={keyPlaceholder}
                  value={pair.key}
                  onChange={event => updatePair(index, { key: event.target.value })}
                  {...inputLimit('paramName')}
                />
              </div>
              <div className="atop-dag-mapping-field">
                <span>{'\u6765\u6e90\u8868\u8fbe\u5f0f'}</span>
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  placeholder={valuePlaceholder}
                  value={pair.value}
                  onChange={event => updatePair(index, { value: event.target.value })}
                  {...inputLimit('paramValue')}
                />
                <div className="atop-dag-mapping-presets">
                  {presets.map(item => (
                    <button key={item.value} type="button" onClick={() => updatePair(index, { value: item.value })}>
                      <span>{item.label}</span>
                      <code>{item.value}</code>
                    </button>
                  ))}
                </div>
              </div>
              <Button className="atop-dag-mapping-delete" type="text" danger icon={<DeleteOutlined />} onClick={() => emit(pairs.filter((_, i) => i !== index))} />
            </div>
          )) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有参数映射，点击下方按钮添加" />
          )}
        </div>
      </Modal>
    </div>
  )
}

function boxesOverlap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + NODE_W + GAP_X
    && a.x + NODE_W + GAP_X > b.x
    && a.y < b.y + NODE_H + GAP_Y
    && a.y + NODE_H + GAP_Y > b.y
}

function resolveFlowDirection(cfg: PipelineDAGConfig): FlowDirectionMeta {
  const components = loadComponents(cfg)
  const componentMap = new Map(components.map(item => [item.id, item]))
  const edges = (cfg.designer?.edges?.length ? cfg.designer.edges : cfg.edges ?? [])
    .filter(edge => edge.source && edge.target)

  let totalDx = 0
  let totalDy = 0
  let linkedCount = 0

  edges.forEach(edge => {
    const source = componentMap.get(edge.source)
    const target = componentMap.get(edge.target)
    if (!source || !target) return
    totalDx += (target.x ?? 0) - (source.x ?? 0)
    totalDy += (target.y ?? 0) - (source.y ?? 0)
    linkedCount += 1
  })

  if (linkedCount > 0) {
    if (Math.abs(totalDx) >= Math.abs(totalDy)) {
      return totalDx >= 0 ? FLOW_DIRECTION_META.lr : FLOW_DIRECTION_META.rl
    }
    return totalDy >= 0 ? FLOW_DIRECTION_META.tb : FLOW_DIRECTION_META.bt
  }

  if (components.length > 1) {
    const xs = components.map(item => item.x ?? 0)
    const ys = components.map(item => item.y ?? 0)
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanY = Math.max(...ys) - Math.min(...ys)
    if (spanX > spanY * 1.2) return FLOW_DIRECTION_META.lr
    if (spanY > spanX * 1.2) return FLOW_DIRECTION_META.tb
  }

  return FLOW_DIRECTION_META.tb
}

export function validateDAGClient(cfg: PipelineDAGConfig): string | null {
  const nodes = cfg.nodes ?? []
  if (!nodes.length) return '请至少添加一个运行组件，例如 Jenkins 组件'

  const ids = new Set<string>()
  const inDegree = new Map<string, number>()
  const outDegree = new Map<string, number>()
  for (const node of nodes) {
    if (!node.id) return '存在没有 ID 的组件，请重新添加该组件'
    if (ids.has(node.id)) return `组件 ID 重复：${node.id}`
    ids.add(node.id)
    inDegree.set(node.id, 0)
    outDegree.set(node.id, 0)
    if (!RUNTIME_COMPONENTS.includes(componentTypeFromDAG(node.type))) {
      return `组件「${node.label || node.id}」类型不支持`
    }
    if (node.type === 'jenkins' && !String(node.config?.jobName ?? '').trim()) {
      return `请为「${node.label || node.id}」配置 Jenkins Job`
    }
    if (node.type === 'pipeline' && !String(node.refId ?? '').trim()) {
      return `请为「${node.label || node.id}」选择子流水线`
    }
  }

  const edges = (cfg.edges ?? []).filter(edge => edge.source && edge.target && ids.has(edge.source) && ids.has(edge.target))
  edges.forEach(edge => {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  })

  for (const node of nodes) {
    const label = node.label || node.id
    if (edges.length > 0 && (inDegree.get(node.id) ?? 0) === 0 && (outDegree.get(node.id) ?? 0) === 0) {
      return `组件「${label}」没有任何连线；如果要并行执行，请连接成分支或仅保留独立并行组件`
    }
    if (node.type === 'gate') {
      if ((inDegree.get(node.id) ?? 0) < 2) return `\u7b49\u5f85/\u6c47\u805a\u7ec4\u4ef6\u300c${label}\u300d\u81f3\u5c11\u9700\u8981\u8fde\u63a5\u4e24\u4e2a\u4e0a\u6e38\u5206\u652f`
      if ((outDegree.get(node.id) ?? 0) === 0) return `\u7b49\u5f85/\u6c47\u805a\u7ec4\u4ef6\u300c${label}\u300d\u9700\u8981\u8fde\u63a5\u4e0b\u6e38\u7ec4\u4ef6`
    }
  }

  return null
}

export default function DAGEditor({
  pipelineId,
  value,
  onChange,
  form,
  jenkinsOptions,
  projectOptions,
  environmentOptions,
  productOptions,
  osOptions,
  runTypeOptions,
  triggerType,
  setTriggerType,
  cronPreset,
  setCronPreset,
  cronPresets,
  readonly = false,
}: Props) {
  const graphRef = useRef<Graph | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const localChangeRef = useRef(false)
  const syncingRef = useRef(false)
  const lastValueRef = useRef('')
  const selectedRef = useRef<SelectedCell>(null)
  const [selected, setSelected] = useState<SelectedCell>(null)
  const [revision, setRevision] = useState(0)
  const [availablePipelines, setAvailablePipelines] = useState<Array<{ id: string; name: string }>>([])
  const [layers, setLayers] = useState<Array<{ layer: number; ids: string[] }>>([])
  const [validating, setValidating] = useState(false)
  const [paletteCollapsed, setPaletteCollapsed] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [hoverTip, setHoverTip] = useState<HoverTip>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu>(null)
  const [isConnecting, setIsConnecting] = useState(false)

  const cfg = value ?? { nodes: [], edges: [], designer: { components: [], edges: [] } }
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const selectedComponent = useMemo(() => {
    if (selected?.kind !== 'node') return undefined
    const graph = graphRef.current
    return graph?.getCellById(selected.id)?.getData() as PipelineDesignerComponent | undefined
  }, [selected, cfg, revision])
  const selectedEdge = useMemo(() => {
    if (selected?.kind !== 'edge') return undefined
    const graph = graphRef.current
    const edge = graph?.getCellById(selected.id) as any
    if (!edge) return undefined
    return {
      id: selected.id,
      source: String(edge.getSourceCellId?.() ?? ''),
      target: String(edge.getTargetCellId?.() ?? ''),
      type: ((edge.getData?.() as any)?.type === 'detached' ? 'detached' : 'wait') as EdgeType,
    }
  }, [selected, cfg, revision])

  const stats = useMemo(() => {
    const components = cfg.designer?.components?.filter(item => isRuntime(item.type)) ?? cfg.nodes ?? []
    const edges = cfg.designer?.edges ?? cfg.edges ?? []
    return {
      runtime: components.length,
      detached: edges.filter(edge => edge.type === 'detached').length,
    }
  }, [cfg])
  const flowDirection = useMemo(() => resolveFlowDirection(cfg), [cfg])
  const canvasConfigWarning = useMemo(() => {
    if (!stats.runtime) return ''
    return validateDAGClient(cfg) ?? ''
  }, [cfg, stats.runtime])

  const setActiveNode = useCallback((graph: Graph, id?: string) => {
    graph.getNodes().forEach(node => {
      const component = node.getData() as PipelineDesignerComponent
      const meta = COMPONENT_META[component.type]
      const active = id && node.id === id
      node.attr({
        body: {
          fill: meta.bg,
          stroke: active ? '#1D4ED8' : meta.color,
          strokeWidth: active ? 3 : 2,
        },
        label: { fill: active ? '#0F3D8F' : meta.color },
      })
    })
  }, [])

  const setHoverNode = useCallback((node: any, active: boolean) => {
    const component = node.getData() as PipelineDesignerComponent
    const meta = COMPONENT_META[component.type]
    const selectedNode = selectedRef.current?.kind === 'node' && selectedRef.current.id === node.id
    node.attr({
      body: {
        fill: active ? '#FFFFFF' : meta.bg,
        stroke: selectedNode ? '#1D4ED8' : active ? '#0F62FE' : meta.color,
        strokeWidth: selectedNode ? 3 : active ? 3 : 2,
        filter: active
          ? { name: 'dropShadow', args: { dx: 0, dy: 8, blur: 12, color: 'rgba(37,99,235,0.18)' } }
          : null,
      },
      label: { fill: selectedNode ? '#0F3D8F' : meta.color },
    })
  }, [])

  const resizeGraph = useCallback(() => {
    const graph = graphRef.current
    const el = canvasWrapRef.current ?? containerRef.current
    if (!graph || !el) return
    const rect = el.getBoundingClientRect()
    const width = Math.max(320, Math.floor(rect.width))
    const height = Math.max(MIN_CANVAS_HEIGHT, Math.floor(rect.height))
    graph.resize(width, height)
  }, [])

  const fitGraphIntoView = useCallback(() => {
    const graph = graphRef.current
    if (!graph) return
    resizeGraph()
    if (!graph.getNodes().length) return
    window.requestAnimationFrame(() => {
      try {
        const content = graph.getContentBBox({ useCellGeometry: true })
        const area = graph.getGraphArea()
        const needsScale = content.width > Math.max(0, area.width - 160)
          || content.height > Math.max(0, area.height - 160)
        if (needsScale) {
          graph.zoomToFit({ padding: 80, maxScale: 1, useCellGeometry: true })
        } else {
          graph.centerContent({ useCellGeometry: true })
        }
      } catch {
        graph.centerContent()
      }
    })
  }, [resizeGraph])

  const notifyChange = useCallback((graph: Graph) => {
    if (syncingRef.current) return
    localChangeRef.current = true
    onChange?.(graphToConfig(graph))
  }, [onChange])

  useEffect(() => {
    const load = async () => {
      try {
        const url = pipelineId ? `/pipelines/${pipelineId}/dag/available-pipelines` : '/pipelines?pageSize=200'
        const res = await client.get<any>(url)
        const items = res.data.data?.items ?? res.data.data ?? []
        setAvailablePipelines(items.map((item: any) => ({ id: item.id, name: item.name })))
      } catch {
        setAvailablePipelines([])
      }
    }
    load()
  }, [pipelineId])

  useEffect(() => {
    if (!containerRef.current || graphRef.current) return
    ensureShapes()
    const graph = new Graph({
      container: containerRef.current,
      height: MIN_CANVAS_HEIGHT,
      background: { color: '#F7F9FC' },
      grid: { visible: true, type: 'dot', size: 16, args: [{ color: '#D7DEEA' }] },
      connecting: {
        router: 'manhattan',
        connector: { name: 'rounded', args: { radius: 8 } },
        allowBlank: false,
        allowLoop: false,
        allowMulti: false,
        highlight: true,
        snap: { radius: 20 },
        createEdge: () => makeEdge('wait'),
        validateConnection({ sourceCell, targetCell, sourcePort, targetPort }) {
          const source = sourceCell?.getData() as PipelineDesignerComponent | undefined
          const target = targetCell?.getData() as PipelineDesignerComponent | undefined
          return sourcePort === 'bottom' && targetPort === 'top' && !!source && !!target && isRuntime(source.type) && isRuntime(target.type)
        },
        validateEdge({ edge }) {
          const source = edge.getSourceCellId()
          const target = edge.getTargetCellId()
          const dup = graph.getEdges().find(item => item !== edge && item.getSourceCellId() === source && item.getTargetCellId() === target)
          if (dup) {
            message.warning('这两个组件之间已经有连线')
            return false
          }
          return true
        },
      },
      mousewheel: { enabled: true, zoomAtMousePosition: true, factor: 1.08, minScale: 0.35, maxScale: 1.8 },
      panning: { enabled: true, eventTypes: ['leftMouseDown'] },
      selecting: {
        enabled: !readonly,
        multiple: true,
        rubberband: true,
        rubberEdge: true,
        modifiers: 'shift',
        showNodeSelectionBox: true,
        showEdgeSelectionBox: true,
      },
      interacting: readonly ? { nodeMovable: false, edgeMovable: false } : {},
    })

    graph.on('node:click', ({ node }) => {
      setSelected({ kind: 'node', id: node.id })
      setActiveNode(graph, node.id)
      setRevision(v => v + 1)
    })
    graph.on('node:mouseenter', ({ node, e }) => {
      setHoverNode(node, true)
      const component = node.getData() as PipelineDesignerComponent
      const description = String(component.config?.description ?? '').trim()
      if (description) {
        setHoverTip({
          x: (e as MouseEvent).clientX,
          y: (e as MouseEvent).clientY,
          title: component.label || COMPONENT_META[component.type].title,
          description,
        })
      }
    })
    graph.on('node:mousemove', ({ e }) => {
      setHoverTip(tip => tip ? { ...tip, x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY } : tip)
    })
    graph.on('node:mouseleave', ({ node }) => {
      setHoverNode(node, false)
      setHoverTip(null)
      setActiveNode(graph, selectedRef.current?.kind === 'node' ? selectedRef.current.id : undefined)
    })
    graph.on('edge:click', ({ edge }) => {
      setSelected({ kind: 'edge', id: edge.id })
      setActiveNode(graph)
      setRevision(v => v + 1)
    })
    graph.on('node:contextmenu', ({ node, e }) => {
      openContextMenu(e, 'node', node)
    })
    graph.on('edge:contextmenu', ({ edge, e }) => {
      openContextMenu(e, 'edge', edge)
    })
    graph.on('blank:contextmenu', ({ e }) => {
      openContextMenu(e, 'blank')
    })
    graph.on('selection:changed', ({ selected: cells }) => {
      setSelectedCount(cells.length)
      if (cells.length === 1) {
        const cell: any = cells[0]
        if (cell.isNode?.()) {
          setSelected({ kind: 'node', id: cell.id })
          setActiveNode(graph, cell.id)
        } else if (cell.isEdge?.()) {
          setSelected({ kind: 'edge', id: cell.id })
          setActiveNode(graph)
        }
      } else if (cells.length === 0) {
        setSelected(null)
        setActiveNode(graph)
      } else {
        setSelected(null)
        setActiveNode(graph)
      }
      setRevision(v => v + 1)
    })
    graph.on('edge:mouseenter', ({ edge }) => {
      const type = ((edge.getData() as any)?.type === 'detached' ? 'detached' : 'wait') as EdgeType
      edge.setAttrs(edgeHoverAttrs(type))
      edge.toFront()
    })
    graph.on('edge:mouseleave', ({ edge }) => {
      const type = ((edge.getData() as any)?.type === 'detached' ? 'detached' : 'wait') as EdgeType
      edge.setAttrs(edgeAttrs(type))
    })
    graph.on('blank:click', () => {
      graph.cleanSelection()
      setSelected(null)
      setActiveNode(graph)
      setHoverTip(null)
      setIsConnecting(false)
    })
    graph.on('node:moved', () => notifyChange(graph))
    graph.on('edge:added', ({ edge }) => {
      setIsConnecting(!edge.getTargetCellId?.())
      applyEdgeType(edge, ((edge.getData() as any)?.type === 'detached' ? 'detached' : 'wait'))
      notifyChange(graph)
    })
    graph.on('edge:connected', ({ edge }) => {
      setIsConnecting(false)
      applyEdgeType(edge, ((edge.getData() as any)?.type === 'detached' ? 'detached' : 'wait'))
      notifyChange(graph)
      setRevision(v => v + 1)
    })
    graph.on('edge:removed', () => {
      setIsConnecting(false)
      notifyChange(graph)
    })
    graph.on('node:removed', () => {
      setSelected(null)
      setActiveNode(graph)
      notifyChange(graph)
    })
    graph.bindKey(['backspace', 'delete'], () => {
      const cells = graph.getSelectedCells()
      if (cells.length) {
        graph.removeCells(cells)
        setActiveNode(graph)
        notifyChange(graph)
      }
    })

    graphRef.current = graph
    syncingRef.current = true
    loadGraph(graph, value)
    syncingRef.current = false
    lastValueRef.current = JSON.stringify(value ?? {})
    window.setTimeout(fitGraphIntoView, 80)
    window.setTimeout(fitGraphIntoView, 220)
    return () => {
      graph.dispose()
      graphRef.current = null
    }
  }, [fitGraphIntoView, setActiveNode, setHoverNode])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !value) return
    if (localChangeRef.current) {
      localChangeRef.current = false
      lastValueRef.current = JSON.stringify(value)
      return
    }
    const next = JSON.stringify(value)
    if (next === lastValueRef.current) return
    syncingRef.current = true
    loadGraph(graph, value)
    syncingRef.current = false
    lastValueRef.current = next
    setActiveNode(graph, selected?.kind === 'node' ? selected.id : undefined)
    window.setTimeout(fitGraphIntoView, 80)
  }, [value, selected, setActiveNode, fitGraphIntoView])

  useEffect(() => {
    const timer = window.setTimeout(fitGraphIntoView, 80)
    return () => window.clearTimeout(timer)
  }, [fullscreen, paletteCollapsed, inspectorCollapsed, fitGraphIntoView])

  useEffect(() => {
    window.addEventListener('resize', resizeGraph)
    return () => window.removeEventListener('resize', resizeGraph)
  }, [resizeGraph])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => resizeGraph())
    if (canvasWrapRef.current) observer.observe(canvasWrapRef.current)
    if (containerRef.current) observer.observe(containerRef.current)
    if (shellRef.current) observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [resizeGraph])

  const updateComponent = (patch: Partial<PipelineDesignerComponent>) => {
    if (!selectedComponent) return
    const graph = graphRef.current
    const cell = graph?.getCellById(selectedComponent.id) as any
    if (!graph || !cell) return
    const next = { ...selectedComponent, ...patch }
    cell.setData(next)
    cell.attr('label/text', nodeLabel(next))
    setActiveNode(graph, next.id)
    notifyChange(graph)
    setRevision(v => v + 1)
    setSelected({ kind: 'node', id: next.id })
  }

  const findOpenPoint = (graph: Graph, preferred?: { x: number; y: number }) => {
    const positions = graph.getNodes().map(node => node.getPosition())
    const rect = containerRef.current?.getBoundingClientRect()
    const base = preferred ?? (rect
      ? graph.clientToLocal(rect.left + 74, rect.top + 74)
      : { x: 80, y: 80 })
    const snapped = {
      x: Math.max(40, Math.round(base.x / 20) * 20),
      y: Math.max(40, Math.round(base.y / 20) * 20),
    }
    if (!positions.some(pos => boxesOverlap(snapped, pos))) return snapped
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 6; col++) {
        const point = { x: snapped.x + col * (NODE_W + GAP_X), y: snapped.y + row * (NODE_H + GAP_Y) }
        if (!positions.some(pos => boxesOverlap(point, pos))) return point
      }
    }
    return { x: snapped.x + NODE_W + GAP_X, y: snapped.y + NODE_H + GAP_Y }
  }

  const addComponent = (type: PipelineDesignerComponentType, point?: { x: number; y: number }) => {
    const graph = graphRef.current
    if (!graph || !isRuntime(type)) return
    const meta = COMPONENT_META[type]
    const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const safePoint = findOpenPoint(graph, point)
    const component: PipelineDesignerComponent = {
      id,
      type,
      label: meta.title,
      x: safePoint.x,
      y: safePoint.y,
      joinPolicy: 'all',
      failurePolicy: 'block',
      inputMapping: {},
      paramMapping: {},
      config: type === 'jenkins' ? { jobName: '' } : {},
    }
    const node = graph.addNode({
      id,
      shape: 'pipeline-builder-node',
      x: component.x,
      y: component.y,
      label: nodeLabel(component),
      data: component,
      attrs: {
        body: { fill: meta.bg, stroke: meta.color },
        label: { fill: meta.color },
      },
    })
    graph.cleanSelection()
    graph.select(node)
    setActiveNode(graph, id)
    notifyChange(graph)
    setRevision(v => v + 1)
    setSelected({ kind: 'node', id })
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const type = event.dataTransfer.getData('application/x-atop-component') as PipelineDesignerComponentType
    if (!type) return
    const graph = graphRef.current
    const point = graph?.clientToLocal(event.clientX, event.clientY)
    addComponent(type, point ? { x: point.x - NODE_W / 2, y: point.y - NODE_H / 2 } : undefined)
  }

  const activeCells = () => {
    const graph = graphRef.current
    if (!graph) return []
    const selectedCells = graph.getSelectedCells()
    if (selectedCells.length > 0) return selectedCells
    if (!selected) return []
    const cell = graph.getCellById(selected.id)
    return cell ? [cell] : []
  }

  const deleteCells = (cells = activeCells()) => {
    const graph = graphRef.current
    if (!graph || !cells.length) {
      message.info('\u8bf7\u5148\u9009\u62e9\u7ec4\u4ef6\u6216\u8fde\u7ebf')
      return
    }
    graph.removeCells(cells)
    setSelected(null)
    setSelectedCount(0)
    setActiveNode(graph)
    notifyChange(graph)
    setContextMenu(null)
  }

  const deleteSelected = () => {
    deleteCells()
  }

  const duplicateSelectedNodes = () => {
    const graph = graphRef.current
    if (!graph || readonly) return
    const nodes = activeCells().filter((cell: any) => cell.isNode?.())
    if (!nodes.length) {
      message.info('请选择要复制的组件')
      return
    }
    const created: any[] = []
    nodes.forEach((node: any, index: number) => {
      const data = node.getData() as PipelineDesignerComponent
      if (!isRuntime(data.type)) return
      const meta = COMPONENT_META[data.type]
      const pos = node.getPosition()
      const id = `node-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
      const next: PipelineDesignerComponent = {
        ...data,
        id,
        label: `${data.label || meta.title} 副本`,
        x: pos.x + 44 + index * 16,
        y: pos.y + 44 + index * 16,
      }
      created.push(graph.addNode({
        id,
        shape: 'pipeline-builder-node',
        x: next.x,
        y: next.y,
        label: nodeLabel(next),
        data: next,
        attrs: {
          body: { fill: meta.bg, stroke: meta.color },
          label: { fill: meta.color },
        },
      }))
    })
    if (!created.length) return
    graph.cleanSelection()
    created.forEach(node => graph.select(node))
    setSelected(created.length === 1 ? { kind: 'node', id: created[0].id } : null)
    setSelectedCount(created.length)
    setActiveNode(graph, created.length === 1 ? created[0].id : undefined)
    notifyChange(graph)
    setRevision(v => v + 1)
    setContextMenu(null)
  }

  const setSelectedEdgesType = (type: EdgeType) => {
    const graph = graphRef.current
    if (!graph || readonly) return
    const edges = activeCells().filter((cell: any) => cell.isEdge?.())
    if (!edges.length) return
    edges.forEach((edge: any) => applyEdgeType(edge, type))
    notifyChange(graph)
    setRevision(v => v + 1)
    setContextMenu(null)
  }

  const openContextMenu = (event: any, kind: 'node' | 'edge' | 'blank', cell?: any) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const graph = graphRef.current
    if (!graph) return
    if (cell) {
      const selectedCells = graph.getSelectedCells()
      const alreadySelected = selectedCells.some(item => item.id === cell.id)
      if (!alreadySelected) {
        graph.cleanSelection()
        graph.select(cell)
        setSelected(kind === 'node' ? { kind: 'node', id: cell.id } : { kind: 'edge', id: cell.id })
        setSelectedCount(1)
      } else if (selectedCells.length === 1) {
        setSelected(kind === 'node' ? { kind: 'node', id: cell.id } : { kind: 'edge', id: cell.id })
        setSelectedCount(1)
      } else {
        setSelected(null)
        setSelectedCount(selectedCells.length)
      }
    } else if (kind === 'blank') {
      graph.cleanSelection()
      setSelected(null)
      setSelectedCount(0)
    }
    setContextMenu({
      x: event?.clientX ?? 0,
      y: event?.clientY ?? 0,
      kind: graph.getSelectedCells().length > 1 ? 'selection' : kind,
      cellId: cell?.id,
    })
  }

  const autoLayout = () => {
    const graph = graphRef.current
    if (!graph) return
    graph.getNodes().forEach((node, index) => {
      const col = index % 3
      const row = Math.floor(index / 3)
      node.setPosition(100 + col * 300, 90 + row * 150)
    })
    notifyChange(graph)
  }

  const validate = async () => {
    const graph = graphRef.current
    if (!graph) return
    const current = graphToConfig(graph)
    const localError = validateDAGClient(current)
    if (localError) {
      message.warning(localError)
      return
    }
    setValidating(true)
    try {
      const res = await client.post<{ data: { layerMap: Record<string, number>; nodeCount: number } }>('/pipelines/validate-dag', current)
      const { layerMap } = res.data.data
      const maxLayer = Math.max(0, ...Object.values(layerMap))
      setLayers(Array.from({ length: maxLayer + 1 }, (_, layer) => ({
        layer,
        ids: Object.entries(layerMap).filter(([, v]) => v === layer).map(([id]) => id),
      })))
      message.success(`验证通过：${current.nodes.length} 个运行组件，${maxLayer + 1} 个执行层`)
    } catch (err: any) {
      message.error(err?.response?.data?.message ?? '画布验证失败')
    } finally {
      setValidating(false)
    }
  }

  const updateRuntimeConfig = (component: PipelineDesignerComponent, patch: Record<string, unknown>) => {
    updateComponent({ config: { ...(component.config ?? {}), ...patch } })
  }

  const toggleFullscreen = () => {
    setFullscreen(current => {
      const next = !current
      if (next) {
        setPaletteCollapsed(true)
        setInspectorCollapsed(true)
      }
      return next
    })
  }

  const renderContextMenu = () => {
    if (!contextMenu) return null
    const graph = graphRef.current
    const cells = graph?.getSelectedCells() ?? []
    const nodeCount = cells.filter((cell: any) => cell.isNode?.()).length
    const edgeCount = cells.filter((cell: any) => cell.isEdge?.()).length
    const title = selectedCount > 1 ? `\u5df2\u9009 ${selectedCount} \u9879` : contextMenu.kind === 'edge' ? '\u8fde\u7ebf\u64cd\u4f5c' : contextMenu.kind === 'node' ? '\u7ec4\u4ef6\u64cd\u4f5c' : '\u753b\u5e03\u64cd\u4f5c'
    return (
      <div
        className="atop-builder-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onContextMenu={event => event.preventDefault()}
      >
        <strong>{title}</strong>
        {nodeCount > 0 && !readonly && <button type="button" onClick={duplicateSelectedNodes}>复制组件</button>}
        {(edgeCount > 0 || contextMenu.kind === 'edge') && !readonly && (
          <>
            <button type="button" onClick={() => setSelectedEdgesType('wait')}>设为等待完成</button>
            <button type="button" onClick={() => setSelectedEdgesType('detached')}>设为异步启动</button>
          </>
        )}
        {contextMenu.kind === 'blank' && (
          <>
            <button type="button" onClick={() => { autoLayout(); setContextMenu(null) }}>自动排列</button>
            <button type="button" onClick={() => { validate(); setContextMenu(null) }}>验证画布</button>
          </>
        )}
        {(selectedCount > 0 || contextMenu.kind === 'node' || contextMenu.kind === 'edge') && !readonly && (
          <button type="button" className="danger" onClick={() => deleteCells()}>删除选中</button>
        )}
      </div>
    )
  }

  const renderPaletteItem = (type: PipelineDesignerComponentType) => {
    const meta = COMPONENT_META[type]
    const button = (
      <button
        key={type}
        type="button"
        className="atop-builder-palette-item"
        draggable
        onDragStart={event => event.dataTransfer.setData('application/x-atop-component', type)}
        onClick={() => addComponent(type)}
        aria-label={meta.title}
      >
        <span style={{ color: meta.color, background: meta.bg }}>{meta.icon}</span>
        <strong>{meta.title}</strong>
        <small>{meta.desc}</small>
      </button>
    )
    return paletteCollapsed ? <Tooltip key={type} title={meta.title} placement="right">{button}</Tooltip> : button
  }

  const handleTriggerTypeChange = (next: string) => {
    setTriggerType(next)
    form.setFieldValue('triggerType', next)
    if (next === 'cron' && !String(form.getFieldValue('cronExpr') ?? '').trim()) {
      form.setFieldValue('cronExpr', cronPreset && cronPreset !== 'custom' ? cronPreset : '0 22 * * *')
    }
  }

  const renderCanvasInspector = () => (
    <div className="atop-builder-inspector-section">
      {canvasConfigWarning && (
        <Alert
          className="atop-builder-rule-alert"
          type="warning"
          showIcon
          message={canvasConfigWarning}
          description={'点击对应组件，在组件属性中补全必填配置后再创建流水线。'}
        />
      )}
      <Form.Item
        label={'\u6d41\u6c34\u7ebf\u540d\u79f0'}
        name="name"
        rules={[{ required: true, message: '\u8bf7\u8f93\u5165\u6d41\u6c34\u7ebf\u540d\u79f0' }, maxLenRule('pipelineName', '\u6d41\u6c34\u7ebf\u540d\u79f0')]}
      >
        <Input placeholder={'\u4f8b\u5982\uff1aV3 \u4e3b\u5e72\u5192\u70df\u6d41\u6c34\u7ebf'} {...inputLimit('pipelineName')} />
      </Form.Item>
      <Form.Item label={'\u9879\u76ee'} name="project" rules={[{ required: true, message: '\u8bf7\u9009\u62e9\u9879\u76ee' }]}>
        <Select showSearch optionFilterProp="label" options={projectOptions} placeholder={'\u9009\u62e9\u5f52\u5c5e\u9879\u76ee'} />
      </Form.Item>
      <Form.Item label={'\u73af\u5883'} name="environment">
        <Select showSearch allowClear optionFilterProp="label" options={environmentOptions} placeholder={'\u9009\u62e9\u73af\u5883'} />
      </Form.Item>
      <Form.Item label={'\u4ea7\u54c1'} name="product">
        <Select showSearch allowClear optionFilterProp="label" options={productOptions} placeholder={'\u9009\u62e9\u4ea7\u54c1'} />
      </Form.Item>
      <Form.Item label={'\u64cd\u4f5c\u7cfb\u7edf'} name="os">
        <Select showSearch allowClear optionFilterProp="label" options={osOptions} placeholder={'\u9009\u62e9\u64cd\u4f5c\u7cfb\u7edf'} />
      </Form.Item>
      <Form.Item label={'\u8fd0\u884c\u7c7b\u578b'} name="runType">
        <Select showSearch allowClear optionFilterProp="label" options={runTypeOptions} placeholder={'\u9009\u62e9\u8fd0\u884c\u7c7b\u578b'} />
      </Form.Item>
      <Form.Item label={'\u89e6\u53d1\u65b9\u5f0f'} name="triggerType" rules={[{ required: true, message: '\u8bf7\u9009\u62e9\u89e6\u53d1\u65b9\u5f0f' }]}>
        <Radio.Group onChange={event => handleTriggerTypeChange(event.target.value)}>
          <Space direction="vertical" size={10}>
            <Radio value="manual">{'\u624b\u52a8\u89e6\u53d1'}</Radio>
            <Radio value="cron">Cron</Radio>
            <Radio value="webhook">Webhook</Radio>
          </Space>
        </Radio.Group>
      </Form.Item>
      {triggerType === 'cron' && (
        <>
          <Form.Item label={'Cron \u6a21\u677f'}>
            <Select
              value={cronPreset}
              options={cronPresets}
              onChange={value => {
                setCronPreset(value)
                if (value && value !== 'custom') form.setFieldValue('cronExpr', value)
              }}
            />
          </Form.Item>
          <Form.Item name="cronExpr" label={'Cron \u8868\u8fbe\u5f0f'} rules={[{ required: true, message: '\u8bf7\u8f93\u5165 Cron \u8868\u8fbe\u5f0f' }, maxLenRule('cronExpr', 'Cron \u8868\u8fbe\u5f0f')]}>
            <Input placeholder="0 22 * * *" onChange={() => setCronPreset('custom')} {...inputLimit('cronExpr')} />
          </Form.Item>
        </>
      )}
      <Form.Item label={'Jenkins \u5b9e\u4f8b'} name="jenkinsInstanceId" rules={[{ required: true, message: '\u8bf7\u9009\u62e9 Jenkins \u5b9e\u4f8b' }]}>
        <Select
          showSearch
          optionFilterProp="label"
          options={jenkinsOptions}
          placeholder={'\u9009\u62e9 Jenkins \u5b9e\u4f8b'}
        />
      </Form.Item>
      <Divider orientation="left" plain>{'\u9884\u5b9a\u4e49\u53c2\u6570'}</Divider>
      <Form.List name="params">
        {(fields, { add, remove }) => (
          <div className="atop-builder-list">
            {fields.map(({ key, name }) => (
              <div key={key} className="atop-builder-form-card">
                <Form.Item name={[name, 'name']} label={'\u53c2\u6570\u540d'} rules={[{ required: true }, maxLenRule('paramName', '\u53c2\u6570\u540d')]}>
                  <Input placeholder="tag" {...inputLimit('paramName')} />
                </Form.Item>
                <Form.Item name={[name, 'type']} label={'\u7c7b\u578b'} initialValue="string">
                  <Select options={[
                    { label: '\u6587\u672c', value: 'string' },
                    { label: '\u6570\u5b57', value: 'number' },
                    { label: '\u5f00\u5173', value: 'boolean' },
                    { label: '\u9009\u9879', value: 'choice' },
                  ]} />
                </Form.Item>
                <Form.Item name={[name, 'defaultValue']} label={'\u9ed8\u8ba4\u503c'} rules={[maxLenRule('paramValue', '\u9ed8\u8ba4\u503c')]}>
                  <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} placeholder="latest" {...inputLimit('paramValue')} />
                </Form.Item>
                <Form.Item name={[name, 'description']} label={'\u63cf\u8ff0'} rules={[maxLenRule('paramDescription', '\u63cf\u8ff0')]}>
                  <Input placeholder={'SDK tag \u7248\u672c'} {...inputLimit('paramDescription')} />
                </Form.Item>
                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(name)}>{'\u5220\u9664\u53c2\u6570'}</Button>
              </div>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: '', type: 'string', defaultValue: '', description: '', required: false })}>
              {'\u6dfb\u52a0\u53c2\u6570'}
            </Button>
          </div>
        )}
      </Form.List>
    </div>
  )

  const renderRuntimeInspector = (component: PipelineDesignerComponent) => (
    <div className="atop-builder-inspector-section">
      <Form.Item label={'\u7ec4\u4ef6\u540d\u79f0'}>
        <Input value={component.label} onChange={event => updateComponent({ label: event.target.value })} {...inputLimit('name')} />
      </Form.Item>
      {component.type === 'jenkins' && (
        <>
          <Alert
            className="atop-builder-rule-alert"
            type="info"
            showIcon
            message={'\u540c\u540d\u8fd0\u884c\u53c2\u6570\u4f1a\u81ea\u52a8\u4f20\u7ed9 Jenkins\uff1b\u53ea\u6709\u6539\u540d\u3001\u7ec4\u5408\u8868\u8fbe\u5f0f\u6216\u8bfb\u53d6\u4e0a\u6e38 outputs/inputs \u65f6\uff0c\u624d\u9700\u8981\u914d\u7f6e\u53c2\u6570\u6620\u5c04\u3002'}
            description={'\u4e0a\u6e38\u8f93\u51fa\u793a\u4f8b\uff1anodes.build.outputs.tag / nodes.build.inputs.BRANCH'}
          />
          <Form.Item label={'Job / Pipeline \u540d\u79f0'} required>
            <Input
              value={String(component.config?.jobName ?? '')}
              placeholder={'build-sdk'}
              onChange={event => updateRuntimeConfig(component, { jobName: event.target.value })}
              {...inputLimit('jobName')}
            />
          </Form.Item>
          <Form.Item label={'\u4efb\u52a1\u8bf4\u660e'}>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={String(component.config?.description ?? '')}
              onChange={event => updateRuntimeConfig(component, { description: event.target.value })}
              {...inputLimit('description')}
            />
          </Form.Item>
          <Divider orientation="left" plain>{'\u53c2\u6570\u6620\u5c04\uff08\u53ef\u9009\uff09'}</Divider>
          <PairMapping
            value={component.inputMapping ?? {}}
            onChange={inputMapping => updateComponent({ inputMapping })}
            keyPlaceholder={'Jenkins \u53c2\u6570\u540d'}
            valuePlaceholder={'runtime.tag / nodes.build.outputs.tag / nodes.build.inputs.BRANCH'}
          />
          <Form.Item
            label={'\u8f93\u51fa\u5b57\u6bb5\u63d0\u793a\uff08\u53ef\u9009\uff09'}
            help={'\u8fd9\u91cc\u53ea\u662f\u6807\u6ce8\u7ec4\u4ef6\u53ef\u80fd\u8f93\u51fa\u7684\u5b57\u6bb5\uff0c\u65b9\u4fbf\u914d\u7f6e\u4e0b\u6e38\uff1b\u5e73\u53f0\u5b9e\u9645\u62ff\u5230\u4ec0\u4e48\uff0c\u4ee5 Jenkins \u56de\u8c03 outputs \u4e3a\u51c6\u3002'}
          >
            <Select
              mode="tags"
              value={component.requiredOutputs ?? []}
              onChange={requiredOutputs => updateComponent({ requiredOutputs })}
              placeholder={'\u5982 tag\u3001module\u3001image'}
              tokenSeparators={[',', '\uFF0C', ' ']}
            />
          </Form.Item>
        </>
      )}
      {component.type === 'pipeline' && (
        <>
          <Form.Item label={'\u9009\u62e9\u5b50\u6d41\u6c34\u7ebf'} required>
            <Select
              showSearch
              optionFilterProp="label"
              value={component.refId}
              options={availablePipelines.map(item => ({ value: item.id, label: item.name }))}
              onChange={refId => {
                const item = availablePipelines.find(row => row.id === refId)
                updateComponent({ refId, label: item?.name ?? component.label })
              }}
            />
          </Form.Item>
          <Divider orientation="left" plain>{'\u5b50\u6d41\u6c34\u7ebf\u53c2\u6570'}</Divider>
          <PairMapping
            value={component.paramMapping ?? {}}
            onChange={paramMapping => updateComponent({ paramMapping })}
            keyPlaceholder={'\u7236\u53c2\u6570'}
            valuePlaceholder={'\u5b50\u53c2\u6570'}
          />
        </>
      )}
      <Form.Item label={'Join \u7b56\u7565'}>
        <Radio.Group value={component.joinPolicy ?? 'all'} onChange={event => updateComponent({ joinPolicy: event.target.value })}>
          <Space direction="vertical">
            <Radio value="all">{'\u7b49\u5f85\u6240\u6709\u4e0a\u6e38\u6210\u529f'}</Radio>
            <Radio value="any">{'\u4efb\u4e00\u4e0a\u6e38\u6210\u529f\u5373\u53ef\u7ee7\u7eed'}</Radio>
          </Space>
        </Radio.Group>
        <div className="atop-builder-field-help">{'Join \u51b3\u5b9a\u591a\u4e2a\u4e0a\u6e38\u6ee1\u8db3\u5230\u4ec0\u4e48\u7a0b\u5ea6\u624d\u542f\u52a8\u5f53\u524d\u7ec4\u4ef6\u3002'}</div>
      </Form.Item>
      <Form.Item label={'\u5931\u8d25\u7b56\u7565'}>
        <Radio.Group value={component.failurePolicy ?? 'block'} onChange={event => updateComponent({ failurePolicy: event.target.value })}>
          <Space direction="vertical">
            <Radio value="block">{'\u4e0a\u6e38\u5931\u8d25\u5219\u963b\u65ad'}</Radio>
            <Radio value="continue">{'\u4e0a\u6e38\u7ed3\u675f\u540e\u7ee7\u7eed'}</Radio>
          </Space>
        </Radio.Group>
        <div className="atop-builder-field-help">{'\u5931\u8d25\u7b56\u7565\u51b3\u5b9a\u5931\u8d25\u3001\u53d6\u6d88\u6216\u63d0\u4ea4\u5931\u8d25\u7684\u4e0a\u6e38\u662f\u5426\u4e5f\u80fd\u4f5c\u4e3a\u5df2\u7ed3\u675f\u6761\u4ef6\u3002'}</div>
      </Form.Item>
    </div>
  )

  return (
    <div ref={shellRef} className={`atop-builder-shell${paletteCollapsed ? ' atop-builder-palette-collapsed' : ''}${inspectorCollapsed ? ' atop-builder-inspector-collapsed' : ''}${fullscreen ? ' atop-builder-fullscreen' : ''}`}>
      <aside className="atop-builder-palette">
        <div className="atop-builder-pane-title">
          <span><FieldBinaryOutlined /></span>
          <div>
            <strong>组件</strong>
            <small>点击或拖动到画布</small>
          </div>
          <Button
            type="text"
            size="small"
            icon={paletteCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setPaletteCollapsed(v => !v)}
            aria-label={paletteCollapsed ? '\u5c55\u5f00\u7ec4\u4ef6\u680f' : '\u6298\u53e0\u7ec4\u4ef6\u680f'}
          />
        </div>
        <div className="atop-builder-palette-group">
          {RUNTIME_COMPONENTS.map(renderPaletteItem)}
        </div>
      </aside>

      <main className="atop-builder-canvas-panel">
        <div className="atop-builder-toolbar">
          <Space wrap>
            <Button icon={<ApartmentOutlined />} onClick={autoLayout}>自动排列</Button>
            <Button icon={<CheckCircleOutlined />} loading={validating} onClick={validate}>验证画布</Button>
            <Button danger icon={<DeleteOutlined />} onClick={deleteSelected}>删除选中</Button>
          </Space>
          <Space wrap>
            <Tag color="blue">{stats.runtime} {'\u4e2a\u7ec4\u4ef6'}</Tag>
            <Tag color="gold">{stats.detached} {'\u6761\u5f02\u6b65\u5206\u652f'}</Tag>
            {selectedCount > 1 && <Tag color="geekblue">{'\u5df2\u9009 '}{selectedCount}{' \u9879'}</Tag>}
            <Tooltip title={fullscreen ? '\u9000\u51fa\u5168\u5c4f' : '\u6700\u5927\u5316\u753b\u5e03'}>
              <Button
                icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={toggleFullscreen}
              />
            </Tooltip>
          </Space>
        </div>
        <div className={`atop-builder-flow-bar${isConnecting ? ' is-connecting' : ''}`}>
          <div className="atop-builder-flow-card">
            <div className={`atop-builder-flow-preview is-${flowDirection.key}`} aria-hidden="true">
              <span className="atop-builder-flow-dot is-start" />
              <i className="atop-builder-flow-line" />
              <span className="atop-builder-flow-dot is-end" />
            </div>
            <div className="atop-builder-flow-copy">
              <strong>{'\u6267\u884c\u65b9\u5411'}</strong>
              <small>{flowDirection.label}</small>
            </div>
          </div>
          <div className="atop-builder-flow-copy is-summary">
            <strong>{flowDirection.summary}</strong>
            <small>{isConnecting ? '\u8fde\u7ebf\u4e2d\u4ec5\u663e\u793a\u5f53\u524d\u53ef\u63a5\u5165\u7684\u5165\u53e3\u70b9\uff0c\u4e0d\u80fd\u8fde\u63a5\u7684\u70b9\u4f1a\u81ea\u52a8\u9690\u85cf\u3002' : flowDirection.description}</small>
          </div>
        </div>
        <div className="atop-builder-hint">
          <span><BranchesOutlined /></span>
          <strong>点击空白画布配置流水线属性；变量写法：{'{'}runtime.tag{'}'}、{'{'}nodes.组件ID.outputs.tag{'}'}、{'{'}nodes.组件ID.inputs.BRANCH{'}'}</strong>
        </div>
        <div
          ref={canvasWrapRef}
          className={`atop-builder-canvas-wrap${isConnecting ? ' is-connecting' : ''}`}
          onDragOver={event => event.preventDefault()}
          onDrop={onDrop}
          onContextMenu={event => event.preventDefault()}
        >
          <div ref={containerRef} className="atop-builder-canvas" />
          {!stats.runtime && (
            <div className="atop-dag-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={'\u4ece\u5de6\u4fa7\u62d6\u5165 Jenkins \u7ec4\u4ef6\u5f00\u59cb\u7f16\u6392'} />
            </div>
          )}
          {hoverTip && (
            <div
              className="atop-builder-node-tip"
              style={{ left: hoverTip.x + 14, top: hoverTip.y + 14 }}
            >
              <strong>{hoverTip.title}</strong>
              <span>{hoverTip.description}</span>
            </div>
          )}
          {renderContextMenu()}
        </div>
      </main>

      <aside className="atop-builder-inspector">
        <div className="atop-builder-pane-title">
          <span>{selectedEdge ? <ThunderboltOutlined /> : selectedComponent ? <SettingOutlined /> : <CompressOutlined />}</span>
          <div>
            <strong>{selectedComponent ? '\u7ec4\u4ef6\u5c5e\u6027' : selectedEdge ? '\u8fde\u7ebf\u5c5e\u6027' : '\u753b\u5e03\u5c5e\u6027'}</strong>
            <small>{selectedComponent ? COMPONENT_META[selectedComponent.type].title : selectedEdge ? '等待/异步' : '名称、项目、触发方式、Jenkins 实例'}</small>
          </div>
          <Tooltip title={inspectorCollapsed ? '\u5c55\u5f00\u5c5e\u6027\u9762\u677f' : '\u6700\u5c0f\u5316\u5c5e\u6027\u9762\u677f'}>
            <Button
              type="text"
              size="small"
              icon={inspectorCollapsed ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setInspectorCollapsed(v => !v)}
              aria-label={inspectorCollapsed ? '\u5c55\u5f00\u5c5e\u6027\u9762\u677f' : '\u6700\u5c0f\u5316\u5c5e\u6027\u9762\u677f'}
            />
          </Tooltip>
        </div>
        {inspectorCollapsed && (
          <div className="atop-builder-inspector-rail">
            <Tooltip title={'\u5c55\u5f00\u5c5e\u6027\u9762\u677f'} placement="left">
              <Button icon={<PushpinOutlined />} onClick={() => setInspectorCollapsed(false)} />
            </Tooltip>
          </div>
        )}
        {!inspectorCollapsed && !selectedComponent && !selectedEdge && renderCanvasInspector()}
        {!inspectorCollapsed && selectedComponent && (
          <>
            <div className="atop-builder-selected-head">
              <span style={{ color: COMPONENT_META[selectedComponent.type].color, background: COMPONENT_META[selectedComponent.type].bg }}>
                {COMPONENT_META[selectedComponent.type].icon}
              </span>
              <div>
                <strong>{selectedComponent.label}</strong>
                <small>{COMPONENT_META[selectedComponent.type].desc}</small>
              </div>
            </div>
            {renderRuntimeInspector(selectedComponent)}
          </>
        )}
        {!inspectorCollapsed && selectedEdge && (
          <div className="atop-builder-inspector-section">
            <div className="atop-builder-selected-head">
              <span><ThunderboltOutlined /></span>
              <div>
                <strong>{edgeLabel(selectedEdge.type)}</strong>
                <small>{selectedEdge.source} → {selectedEdge.target}</small>
              </div>
            </div>
            <Radio.Group
              className="atop-dag-edge-mode"
              value={selectedEdge.type}
              onChange={event => {
                const graph = graphRef.current
                const edge = graph?.getCellById(selectedEdge.id) as any
                if (!graph || !edge) return
                applyEdgeType(edge, event.target.value)
                notifyChange(graph)
                setRevision(v => v + 1)
                setSelected({ kind: 'edge', id: selectedEdge.id })
              }}
            >
              <Radio.Button value="wait">等待完成</Radio.Button>
              <Radio.Button value="detached">异步启动</Radio.Button>
            </Radio.Group>
            <Alert
              showIcon
              type={selectedEdge.type === 'detached' ? 'warning' : 'info'}
              message={selectedEdge.type === 'detached'
                ? '\u5f02\u6b65\u5206\u652f\u4f1a\u5728\u4e0a\u6e38\u5b8c\u6210\u540e\u542f\u52a8\uff0c\u4e0a\u6e38 outputs \u548c inputs \u4ecd\u53ef\u6620\u5c04\u4e3a Jenkins \u53c2\u6570\uff1b\u5b83\u7684\u6267\u884c\u7ed3\u679c\u4e0d\u5f71\u54cd\u4e3b\u6d41\u7a0b\u5b8c\u6210\u72b6\u6001\u3002'
                : '\u7b49\u5f85\u8fde\u7ebf\u4f1a\u963b\u585e\u4e0b\u6e38\uff0c\u76f4\u5230\u4e0a\u6e38\u6309 Join / \u5931\u8d25\u7b56\u7565 \u6ee1\u8db3\u6761\u4ef6\u3002'}
            />
          </div>
        )}
        {!inspectorCollapsed && !!layers.length && (
          <div className="atop-builder-plan-mini">
            <Divider orientation="left" plain>执行计划</Divider>
            {layers.map(layer => (
              <div key={layer.layer}>
                <Tag color="blue">{'\u7b2c '}{layer.layer + 1}{' \u5c42'}</Tag>
                <span>{layer.ids.length} {'\u4e2a\u8fd0\u884c\u7ec4\u4ef6'}</span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}





