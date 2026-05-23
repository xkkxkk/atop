import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ThunderboltOutlined, TrophyOutlined, AimOutlined, LineChartOutlined,
  CloseCircleOutlined, DesktopOutlined, CheckCircleOutlined,
  BarChartOutlined, ToolOutlined, WarningOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { runApi } from '@/api/pipelines'
import { jenkinsApi } from '@/api/settings'

// ── Types ─────────────────────────────────────────────────────────────────────
interface RunSummary {
  id: string
  pipelineName: string
  status: string
  passRate: number
  totalCount: number
  successCount: number
  failedCount: number
  runningCount: number
  project: string
  startedAt?: string
  durationMs?: number
}

interface PipelineStat {
  pipelineId: string
  pipelineName: string
  runCount: number
  avgPassRate: number
  exceptionRuns?: number
  exceptionRate?: number
}

interface TrendPoint {
  date: string
  passRate: number
  totalCount?: number
  runCount?: number
  failedCount?: number
  abortedCount?: number
  durationMs?: number
}

interface TopFailingStat {
  pipelineId: string
  pipelineName: string
  runCount: number
  failedRuns: number
  abortedRuns: number
  exceptionRuns?: number
  exceptionRate?: number
  failureRate?: number
  avgPassRate?: number
}

interface DashboardSummary {
  totalRuns?: number
  avgPassRate?: number
  avgDuration?: number
  totalFailed?: number
  totalAborted?: number
  exceptionRate?: number
  activePipelineCount?: number
  unstablePipelineCount?: number
  avgRunsPerDay?: number
  topFailing?: TopFailingStat[]
}

interface AgentNodeStat {
  id: string
  name: string
  online: boolean
  instanceId: string
  labels?: string[]
}

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  bg:       '#0A0E1A',
  card:     '#0F1629',
  border:   'rgba(56,139,253,0.2)',
  glow:     'rgba(56,139,253,0.08)',
  accent:   '#388BFD',
  green:    '#3FB950',
  red:      '#F85149',
  yellow:   '#D29922',
  purple:   '#A371F7',
  cyan:     '#39D4CD',
  text:     '#E6EDF3',
  muted:    '#7D8590',
  gridLine: 'rgba(255,255,255,0.06)',
}

const STATUS_COLOR: Record<string, string> = {
  running: C.accent, success: C.green, failed: C.red,
  pending: C.yellow, aborted: C.muted, error: C.red,
}

function num(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function fmtMs(ms?: number) {
  const value = num(ms)
  if (value <= 0) return '暂无'
  const totalSeconds = Math.round(value / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `${hours}h${rest}m`
  }
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

// ── Safe fetch — never throws, returns null on error ─────────────────────────
async function safeFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

// ── Ring chart (SVG) ──────────────────────────────────────────────────────────
function RingChart({ value, size = 80, color = C.green }: { value: number; size?: number; color?: string }) {
  const r   = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const pct  = Math.min(100, Math.max(0, value))
  const dash = (pct / 100) * circ
  return (
    <svg width={size} height={size}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.gridLine} strokeWidth={8} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={8}
        strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.8s ease' }}
      />
      <text x={size/2} y={size/2 + 5} textAnchor="middle"
        fontSize={size * 0.22} fontWeight={700} fill={C.text}>
        {pct.toFixed(0)}%
      </text>
    </svg>
  )
}

// ── Trend line (SVG) ──────────────────────────────────────────────────────────
function TrendLine({ points, w = 200, h = 50 }: { points: number[]; w?: number; h?: number }) {
  if (points.length < 2) return null
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const range = max - min || 1
  const step  = w / (points.length - 1)
  const coords = points.map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 8) - 4}`)
  const path   = `M ${coords.join(' L ')}`
  const area   = `M 0,${h} L ${coords.join(' L ')} L ${(points.length-1)*step},${h} Z`
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.accent} stopOpacity={0.3} />
          <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#trendGrad)" />
      <path d={path} fill="none" stroke={C.accent} strokeWidth={2} strokeLinecap="round" />
      {/* last point dot */}
      <circle cx={(points.length-1)*step} cy={h - ((points[points.length-1] - min) / range) * (h-8) - 4}
        r={3} fill={C.accent} />
    </svg>
  )
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function DCard({
  title, icon, children, style, extra,
}: {
  title: string; icon?: ReactNode; children: ReactNode
  style?: React.CSSProperties; extra?: ReactNode
}) {
  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: '16px 20px',
      boxShadow: `0 0 24px ${C.glow}`,
      ...style,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {icon && <span style={{ display: 'inline-flex', color: C.accent, fontSize: 16 }}>{icon}</span>}
          <span style={{ fontSize: 13, fontWeight: 600, color: C.accent, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {title}
          </span>
        </div>
        {extra}
      </div>
      {children}
    </div>
  )
}

// ── Status dot ────────────────────────────────────────────────────────────────
function Dot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? C.muted
  const isRunning = status === 'running'
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 8, height: 8, marginRight: 6 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: color, opacity: isRunning ? 0.4 : 1,
        animation: isRunning ? 'ping 1.5s infinite' : undefined,
      }} />
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Dashboard Component
// ─────────────────────────────────────────────────────────────────────────────
export default function FullscreenDashboard() {
  const navigate     = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFs, setIsFs]  = useState(false)
  const [tick, setTick]  = useState(0)
  const [now, setNow]    = useState(new Date())

  // Data state — never reset to null/empty on error
  const [runs,        setRuns]        = useState<RunSummary[]>([])
  const [pipelineStats,setPipelineStats]= useState<PipelineStat[]>([])
  const [trend,       setTrend]       = useState<TrendPoint[]>([])
  const [agentNodes,  setAgentNodes]  = useState<AgentNodeStat[]>([])
  const [summary,     setSummary]     = useState<DashboardSummary>({})

  // Derived summary
  const hasSummary   = num(summary.totalRuns) > 0
  const totalRuns    = hasSummary ? num(summary.totalRuns) : runs.length
  const runningCount = runs.filter(r => r.status === 'running' || r.status === 'pending').length
  const avgPassRate  = hasSummary ? num(summary.avgPassRate) : (runs.length ? runs.reduce((s,r) => s+r.passRate, 0) / runs.length : 0)
  const failedRuns   = hasSummary ? num(summary.totalFailed) + num(summary.totalAborted) : runs.filter(r => r.status === 'failed' || r.status === 'aborted' || r.status === 'error').length
  const exceptionRate = hasSummary ? num(summary.exceptionRate) : (totalRuns ? failedRuns * 100 / totalRuns : 0)
  const activePipelineCount = hasSummary ? num(summary.activePipelineCount) : new Set(runs.map((r) => r.pipelineName).filter(Boolean)).size
  const unstablePipelineCount = hasSummary ? num(summary.unstablePipelineCount) : new Set(runs.filter((r) => r.failedCount > 0 || ['failed', 'aborted', 'error'].includes(r.status)).map((r) => r.pipelineName).filter(Boolean)).size
  const avgRunsPerDay = hasSummary ? num(summary.avgRunsPerDay) : 0
  const avgDuration = hasSummary ? num(summary.avgDuration) : 0
  const onlineAgents = agentNodes.filter((node) => node.online).length
  const totalAgents = agentNodes.length
  const agentOnlineRate = totalAgents > 0 ? onlineAgents * 100 / totalAgents : 0

  // ── Fetch data silently ──────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const summaryData = await safeFetch(() => client.get('/stats/summary', { params: { days: 30 } }).then(r => r.data.data ?? r.data))
    if (summaryData) {
      setSummary(summaryData as DashboardSummary)
    }

    const trendData = await safeFetch(() => client.get('/stats/trends', { params: { days: 30, groupBy: 'day' } }).then(r => r.data.data ?? r.data))
    if ((trendData as any)?.points) {
      setTrend((trendData as any).points as TrendPoint[])
    }

    const pipelineData = await safeFetch(() => client.get('/stats/pipelines', { params: { days: 30, page: 1, pageSize: 50 } }).then(r => r.data.data ?? r.data))
    if ((pipelineData as any)?.items) {
      setPipelineStats(((pipelineData as any).items as PipelineStat[])
        .sort((a, b) => b.runCount - a.runCount || b.avgPassRate - a.avgPassRate)
        .slice(0, 6))
    }

    // Pipeline runs
    const runsData = await safeFetch(() => runApi.list({ page: 1, pageSize: 50 }))
    if (runsData?.items) {
      const items = (runsData.items as unknown as RunSummary[]).map((item) => ({
        ...item,
        project: item.project || item.pipelineName?.split('_')[0] || 'Unknown',
        passRate: num(item.passRate),
        totalCount: num(item.totalCount),
        successCount: num(item.successCount),
        failedCount: num(item.failedCount),
        runningCount: num(item.runningCount),
      }))
      setRuns(items)

      if (!(trendData as any)?.points) {
        const recent = [...items].sort((a,b) =>
          new Date(b.startedAt||0).getTime() - new Date(a.startedAt||0).getTime()
        ).slice(0, 12).reverse()
        setTrend(recent.map(r => ({
          date: r.startedAt || '',
          passRate: r.passRate,
          totalCount: r.totalCount,
          runCount: 1,
        })))
      }
    }

    const nodesData = await safeFetch(() => jenkinsApi.listAgentNodes())
    if (nodesData) {
      setAgentNodes((nodesData as any[]).map((node: any) => ({
        id: node.id || `${node.jenkinsInstanceId}-${node.nodeId || node.name}`,
        name: node.name || node.nodeId || '未知节点',
        online: Boolean(node.online),
        instanceId: node.jenkinsInstanceId || '',
        labels: node.labels ?? [],
      })))
    }
  }, [])

  // ── 5s auto refresh ──────────────────────────────────────────────────────
  useEffect(() => {
    refresh()
    const id = setInterval(() => {
      setTick(t => t + 1)
      refresh()
      setNow(new Date())
    }, 5000)
    return () => clearInterval(id)
  }, [refresh])

  // ── Fullscreen API ────────────────────────────────────────────────────────
  const enterFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen) el.requestFullscreen()
    else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen()
  }, [])

  const exitFullscreen = useCallback(() => {
    if (document.exitFullscreen) document.exitFullscreen()
    else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen()
  }, [])

  useEffect(() => {
    const handler = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    document.addEventListener('webkitfullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      document.removeEventListener('webkitfullscreenchange', handler)
    }
  }, [])

  // ── Keyboard: ESC already handled by browser; F to toggle ────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) navigate('/dashboard')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])

  // ── Running pipelines (top 6) ─────────────────────────────────────────────
  const running = runs
    .filter(r => r.status === 'running' || r.status === 'pending')
    .slice(0, 6)

  const failedTop = (summary.topFailing ?? []).slice(0, 5)

  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false })
  const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
  const trendValues = trend.map(t => t.passRate)

  return (
    <>
      <style>{`
        @keyframes ping {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50% { transform: scale(2); opacity: 0; }
        }
        @keyframes glow-pulse {
          0%, 100% { box-shadow: 0 0 20px rgba(56,139,253,0.15); }
          50%       { box-shadow: 0 0 40px rgba(56,139,253,0.35); }
        }
        .atop-dash * { box-sizing: border-box; }
        .atop-dash::-webkit-scrollbar { width: 4px; }
        .atop-dash::-webkit-scrollbar-track { background: transparent; }
        .atop-dash::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
      `}</style>

      <div
        ref={containerRef}
        className="atop-dash"
        style={{
          position: isFs ? 'fixed' : 'relative',
          inset: isFs ? 0 : undefined,
          zIndex: isFs ? 9999 : undefined,
          background: C.bg,
          minHeight: '100vh',
          fontFamily: "'SF Pro Display', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: C.text,
          overflow: 'auto',
          padding: '16px 20px',
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 16 }}>
          {/* Logo & Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'linear-gradient(135deg, #1a3a6b, #2563EB)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, fontSize: 18, color: '#fff',
              boxShadow: '0 0 16px rgba(56,139,253,0.5)',
            }}>A</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', color: C.text }}>
                ATOP 运行监控大盘
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>Auto Test Orchestration Platform</div>
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {/* Clock */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: C.accent, lineHeight: 1 }}>
              {timeStr}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{dateStr}</div>
          </div>

          {/* Refresh indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 20, background: 'rgba(56,139,253,0.1)',
            border: `1px solid ${C.border}` }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green,
              boxShadow: `0 0 6px ${C.green}`, display: 'inline-block' }} />
            <span style={{ fontSize: 11, color: C.muted }}>5s 刷新</span>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={isFs ? exitFullscreen : enterFullscreen}
              style={{
                background: 'rgba(56,139,253,0.15)', border: `1px solid ${C.border}`,
                color: C.accent, borderRadius: 8, padding: '6px 14px',
                cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}
            >
              {isFs ? '⊠ 退出全屏' : '⊞ 全屏'}
            </button>
            {!isFs && (
              <button
                onClick={() => navigate('/dashboard')}
                style={{
                  background: 'transparent', border: `1px solid ${C.border}`,
                  color: C.muted, borderRadius: 8, padding: '6px 14px',
                  cursor: 'pointer', fontSize: 12,
                }}
              >
                ← 返回
              </button>
            )}
          </div>
        </div>

        {/* ── Row 1: Summary metrics ──────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 14 }}>
          {[
            { label: '近30天运行', value: totalRuns,                icon: <BarChartOutlined />, color: C.accent,  sub: `日均 ${avgRunsPerDay.toFixed(1)} 次` },
            { label: '进行中',     value: runningCount,             icon: <ThunderboltOutlined />, color: C.yellow,  sub: '实时' },
            { label: '平均通过率', value: `${avgPassRate.toFixed(1)}%`, icon: <CheckCircleOutlined />, color: avgPassRate >= 80 ? C.green : avgPassRate >= 60 ? C.yellow : C.red, sub: '近30天' },
            { label: '活跃流水线', value: activePipelineCount,      icon: <ToolOutlined />, color: C.purple,  sub: `${unstablePipelineCount} 条需关注` },
            { label: '异常次数', value: failedRuns,                 icon: <WarningOutlined />,  color: failedRuns > 0 ? C.red : C.green, sub: `异常率 ${exceptionRate.toFixed(1)}%` },
          ].map(m => (
            <div key={m.label} style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: '16px 20px',
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05)`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {m.label}
                  </div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: m.color, lineHeight: 1,
                    textShadow: `0 0 20px ${m.color}60` }}>
                    {m.value}
                  </div>
                </div>
                <span style={{ color: m.color, fontSize: 24, opacity: 0.7 }}>{m.icon}</span>
              </div>
              <div style={{ marginTop: 10, fontSize: 10, color: C.muted }}>{m.sub}</div>
            </div>
          ))}
        </div>

        {/* ── Row 2: Main content ─────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 320px', gap: 12, marginBottom: 14 }}>

          {/* Running pipelines */}
          <DCard title="进行中的流水线" icon={<ThunderboltOutlined />}
            extra={<span style={{ fontSize: 11, color: C.muted }}>{runningCount} 条运行中</span>}>
            {running.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 13 }}>
                当前无运行中的流水线
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {running.map(r => (
                  <div key={r.id} style={{
                    background: 'rgba(56,139,253,0.05)', borderRadius: 8,
                    padding: '10px 14px', border: `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Dot status={r.status} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.pipelineName}</span>
                      </div>
                      <span style={{ fontSize: 11, color: C.muted }}>
                        {r.successCount}/{r.totalCount} 完成
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: '100%',
                        background: `linear-gradient(90deg, ${C.accent}, ${C.cyan})`,
                        transform: `scaleX(${r.totalCount > 0 ? (r.successCount + r.failedCount) / r.totalCount : 0})`,
                        transformOrigin: 'left center',
                        transition: 'transform 0.5s ease',
                      }} />
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: C.muted }}>
                      <span style={{ color: C.green }}>✓ {r.successCount}</span>
                      <span style={{ color: r.failedCount > 0 ? C.red : C.muted }}>✗ {r.failedCount}</span>
                      <span style={{ color: C.yellow }}>⟳ {r.runningCount}</span>
                      <span style={{ marginLeft: 'auto', color: r.passRate >= 80 ? C.green : C.yellow }}>
                        {r.passRate.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DCard>

          {/* Pipeline pass rate ranking */}
          <DCard title="高频流水线质量" icon={<TrophyOutlined />}
            extra={<span style={{ fontSize: 11, color: C.muted }}>TOP {pipelineStats.length}</span>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {pipelineStats.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 13 }}>暂无数据</div>
              ) : pipelineStats.map((p, i) => {
                const passRate = num(p.avgPassRate)
                const barColor = passRate >= 90 ? C.green : passRate >= 70 ? C.yellow : C.red
                return (
                  <div key={p.pipelineId || p.pipelineName}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: i < 3 ? C.yellow : C.muted, fontSize: 12, fontWeight: 800 }}>#{i + 1}</span>
                        <span style={{ fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.pipelineName}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: barColor }}>
                          {passRate.toFixed(1)}%
                        </span>
                        <span style={{ fontSize: 10, color: C.muted, marginLeft: 8 }}>
                          {p.runCount} 次
                        </span>
                      </div>
                    </div>
                    <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 3,
                        width: '100%',
                        background: `linear-gradient(90deg, ${barColor}88, ${barColor})`,
                        transform: `scaleX(${passRate / 100})`,
                        transformOrigin: 'left center',
                        transition: 'transform 0.8s ease',
                        boxShadow: `0 0 6px ${barColor}60`,
                      }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </DCard>

          {/* Overall pass rate ring */}
          <DCard title="30天质量概览" icon={<AimOutlined />}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <RingChart
                value={avgPassRate}
                size={110}
                color={avgPassRate >= 80 ? C.green : avgPassRate >= 60 ? C.yellow : C.red}
              />
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: '运行次数', value: totalRuns, color: C.green },
                  { label: '异常次数', value: failedRuns, color: C.red },
                  { label: '平均耗时', value: fmtMs(avgDuration), color: C.yellow },
                ].map(s => (
                  <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color,
                        display: 'inline-block', boxShadow: `0 0 4px ${s.color}` }} />
                      <span style={{ color: C.muted }}>{s.label}</span>
                    </div>
                    <span style={{ color: s.color, fontWeight: 600 }}>{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </DCard>
        </div>

        {/* ── Row 3: Trend + Risk + Capacity ─────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

          {/* Trend chart */}
          <DCard title="30天通过率趋势" icon={<LineChartOutlined />}
            extra={<span style={{ fontSize: 11, color: C.muted }}>按天聚合</span>}>
            {trend.length < 2 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 13 }}>数据积累中</div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>最新</span>
                  <span style={{ color: C.accent, fontWeight: 700 }}>
                    {trendValues[trendValues.length-1]?.toFixed(1)}%
                  </span>
                </div>
                <div style={{ width: '100%', overflowX: 'hidden' }}>
                  <TrendLine points={trendValues} w={Math.max(200, trendValues.length * 20)} h={60} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: C.muted }}>
                  <span>最低 {Math.min(...trendValues).toFixed(1)}%</span>
                  <span>最高 {Math.max(...trendValues).toFixed(1)}%</span>
                  <span>均值 {(trendValues.reduce((a,b)=>a+b,0)/trendValues.length).toFixed(1)}%</span>
                </div>
              </div>
            )}
          </DCard>

          {/* Quality risks */}
          <DCard title="质量风险 Top 5" icon={<CloseCircleOutlined />}>
            {failedTop.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <CheckCircleOutlined style={{ color: C.green, fontSize: 30, marginBottom: 8 }} />
                <div style={{ color: C.green, fontSize: 13, fontWeight: 500 }}>近 30 天暂无异常流水线</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {failedTop.map(r => (
                  <div key={r.pipelineId || r.pipelineName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <Dot status="failed" />
                      <span style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.pipelineName}
                      </span>
                    </div>
                    <div style={{ flexShrink: 0, display: 'flex', gap: 8, fontSize: 11 }}>
                      <span style={{ color: C.red }}>{num(r.exceptionRate, r.failureRate).toFixed(1)}%</span>
                      <span style={{ color: C.muted }}>{num(r.exceptionRuns, num(r.failedRuns) + num(r.abortedRuns))}/{r.runCount}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DCard>

          {/* Agent nodes */}
          <DCard title="Agent 容量状态" icon={<DesktopOutlined />}
            extra={
              <span style={{ fontSize: 11, color: C.green }}>
                {onlineAgents} / {totalAgents} 在线
              </span>
            }>
            {agentNodes.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 13 }}>暂无 Agent 数据</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 16, alignItems: 'center', marginBottom: 10 }}>
                  <RingChart
                    value={agentOnlineRate}
                    size={100}
                    color={agentOnlineRate >= 80 ? C.green : agentOnlineRate >= 50 ? C.yellow : C.red}
                  />
                  <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
                    <span style={{ color: C.muted }}>在线率 <strong style={{ color: C.text }}>{agentOnlineRate.toFixed(0)}%</strong></span>
                    <span style={{ color: C.muted }}>Jenkins Node <strong style={{ color: C.text }}>{totalAgents}</strong></span>
                    <span style={{ color: C.muted }}>异常节点 <strong style={{ color: totalAgents - onlineAgents > 0 ? C.red : C.green }}>{totalAgents - onlineAgents}</strong></span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {agentNodes.slice(0, 5).map((node) => (
                    <div key={node.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                      <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                      <span style={{ color: node.online ? C.green : C.red, flexShrink: 0 }}>{node.online ? '在线' : '离线'}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: C.muted }}>
                  <span>按 Jenkins Node 统计</span>
                  <span>不按标签重复计数</span>
                  <span>{agentNodes.length > 5 ? `仅显示 5/${agentNodes.length}` : '节点池一致'}</span>
                </div>
              </div>
            )}
          </DCard>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between',
          fontSize: 11, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
          <span>ATOP · 自动化测试编排调度平台</span>
          <span>刷新周期 5s · 第 {tick} 次刷新</span>
          <span>数据更新: {now.toLocaleTimeString('zh-CN')}</span>
        </div>
      </div>
    </>
  )
}
