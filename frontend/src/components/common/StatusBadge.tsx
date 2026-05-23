import { Tag, Tooltip } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import type { TaskRunStatus, PipelineRunStatus, LogStatus } from '@/types'

// ── Color map ─────────────────────────────────────────────────────────────
const TASK_STATUS_MAP: Record<TaskRunStatus, { color: string; bg: string; label: string }> = {
  waiting:           { color: '#854F0B', bg: '#FAEEDA', label: '等待中' },
  pending:           { color: '#5F5E5A', bg: '#F5F5F4', label: '排队中' },
  submitting:        { color: '#185FA5', bg: '#E6F1FB', label: '下发中' },
  submit_failed:     { color: '#791F1F', bg: '#FCEBEB', label: '下发失败' },
  queued_in_jenkins: { color: '#185FA5', bg: '#E6F1FB', label: 'Jenkins 排队' },
  running:           { color: '#185FA5', bg: '#E6F1FB', label: '运行中' },
  success:           { color: '#085041', bg: '#E1F5EE', label: '成功' },
  failed:            { color: '#791F1F', bg: '#FCEBEB', label: '失败' },
  error:             { color: '#791F1F', bg: '#FCEBEB', label: '异常' },
  aborted:           { color: '#5F5E5A', bg: '#F5F5F4', label: '已中止' },
  blocked:           { color: '#633806', bg: '#FAEEDA', label: '已阻断' },
}

const PIPELINE_STATUS_MAP: Record<PipelineRunStatus, { color: string; bg: string; label: string }> = {
  pending:           { color: '#5F5E5A', bg: '#F5F5F4', label: '待运行' },
  submitting:        { color: '#185FA5', bg: '#E6F1FB', label: '下发中' },
  queued_in_jenkins: { color: '#185FA5', bg: '#E6F1FB', label: 'Jenkins 排队' },
  waiting:           { color: '#854F0B', bg: '#FAEEDA', label: '等待中' },
  running:           { color: '#185FA5', bg: '#E6F1FB', label: '运行中' },
  success:           { color: '#085041', bg: '#E1F5EE', label: '成功' },
  failed:            { color: '#791F1F', bg: '#FCEBEB', label: '失败' },
  blocked:           { color: '#633806', bg: '#FAEEDA', label: '已阻断' },
  aborted:           { color: '#5F5E5A', bg: '#F5F5F4', label: '已中止' },
  error:             { color: '#791F1F', bg: '#FCEBEB', label: '异常' },
}

interface TaskStatusBadgeProps {
  status: TaskRunStatus
  blockedBy?: string
  showDot?: boolean
}

export function TaskStatusBadge({ status, blockedBy, showDot }: TaskStatusBadgeProps) {
  const cfg = TASK_STATUS_MAP[status] ?? { color: '#5F5E5A', bg: '#F5F5F4', label: status || '未知' }
  const isRunning = status === 'running' || status === 'submitting' || status === 'queued_in_jenkins'

  const tag = (
    <Tag
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: 'none',
        borderRadius: 9,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '20px',
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        margin: 0,
      }}
    >
      {isRunning && <LoadingOutlined style={{ fontSize: 10 }} />}
      {showDot && !isRunning && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: cfg.color, display: 'inline-block', flexShrink: 0,
        }} />
      )}
      {cfg.label}
    </Tag>
  )

  if (status === 'blocked' && blockedBy) {
    return <Tooltip title={`因上游任务失败而阻断`}>{tag}</Tooltip>
  }
  return tag
}

interface PipelineStatusBadgeProps { status: PipelineRunStatus }

export function PipelineStatusBadge({ status }: PipelineStatusBadgeProps) {
  const cfg = PIPELINE_STATUS_MAP[status] ?? { color: '#5F5E5A', bg: '#F5F5F4', label: status || '未知' }
  const isRunning = status === 'running' || status === 'submitting' || status === 'queued_in_jenkins'
  return (
    <Tag style={{
      color: cfg.color, background: cfg.bg, border: 'none',
      borderRadius: 9, fontSize: 12, fontWeight: 500,
      lineHeight: '20px', padding: '0 8px',
      display: 'inline-flex', alignItems: 'center', gap: 4, margin: 0,
    }}>
      {isRunning && <LoadingOutlined style={{ fontSize: 10 }} />}
      {cfg.label}
    </Tag>
  )
}

// ── Log status indicator ──────────────────────────────────────────────────
const LOG_STATUS_MAP: Record<LogStatus, { label: string; color: string }> = {
  unknown:   { label: '未检测', color: '#9C9A92' },
  available: { label: '日志存在', color: '#0F6E56' },
  expired:   { label: '已清理', color: '#A32D2D' },
}

interface LogStatusTagProps { status: LogStatus; checkedAt?: string }

export function LogStatusTag({ status, checkedAt }: LogStatusTagProps) {
  const cfg = LOG_STATUS_MAP[status] ?? { label: status || '未知', color: '#9C9A92' }
  const tag = (
    <span style={{ fontSize: 12, color: cfg.color, cursor: checkedAt ? 'help' : 'default' }}>
      {cfg.label}
    </span>
  )
  if (checkedAt) {
    return <Tooltip title={`检测于 ${checkedAt}`}>{tag}</Tooltip>
  }
  return tag
}

// ── Enabled/Disabled toggle badge ────────────────────────────────────────
interface EnabledBadgeProps { status: 'enabled' | 'disabled' }

export function EnabledBadge({ status }: EnabledBadgeProps) {
  const isEnabled = status === 'enabled'
  return (
    <Tag style={{
      color:      isEnabled ? '#085041' : '#9C9A92',
      background: isEnabled ? '#E1F5EE' : '#F5F5F4',
      border: 'none', borderRadius: 9, fontSize: 12,
      fontWeight: 500, lineHeight: '20px', padding: '0 8px', margin: 0,
    }}>
      {isEnabled ? '启用' : '禁用'}
    </Tag>
  )
}
