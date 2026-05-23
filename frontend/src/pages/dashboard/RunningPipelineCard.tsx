import { useState } from 'react'
import { Card, Button } from 'antd'
import { LoadingOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import useSWR from 'swr'
import { runApi, taskRunApi } from '@/api/pipelines'
import ProgressBar from '@/components/common/ProgressBar'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { fmtDuration, fmtRate, rateColor } from '@/utils/format'
import type { PipelineRun, TaskRun } from '@/types'

interface Props {
  run: PipelineRun
  onViewDetail: () => void
}

export default function RunningPipelineCard({ run, onViewDetail }: Props) {
  const [expandedProj, setExpandedProj] = useState<string[]>([])

  // Poll for live updates every 5s while running
  const { data: liveRun } = useSWR(
    run.status === 'running' ? [`run-live`, run.id] : null,
    () => runApi.get(run.id),
    { refreshInterval: 5_000 }
  )

  const current = liveRun ?? run
  const hasTaskStats = current.totalCount > 0
  const pct = current.totalCount > 0
    ? Math.round(((current.successCount + current.failedCount + current.blockedCount) / current.totalCount) * 100)
    : 0

  const progressColor = current.failedCount > 0 ? '#DC2626' : '#1D9E75'

  return (
    <Card
      size="small"
      style={{ marginBottom: 10 }}
      styles={{ body: { padding: 14 } }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <LoadingOutlined style={{ color: '#2563EB', fontSize: 14 }} />
        <span style={{ fontWeight: 500, fontSize: 14 }}>{current.pipelineName}</span>
        <PipelineStatusBadge status={current.status} />
        <span style={{ fontSize: 12, color: '#9C9A92', marginLeft: 'auto' }}>
          已运行 {fmtDuration(Date.now() - new Date(current.startedAt).getTime())}
        </span>
        <Button size="small" onClick={onViewDetail}>查看详情</Button>
      </div>

      {hasTaskStats ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ProgressBar value={pct} color={progressColor} height={8} />
          <span style={{ fontSize: 12, color: '#5F5E5A', whiteSpace: 'nowrap' }}>
            {current.successCount + current.failedCount} / {current.totalCount} · {pct}%
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#5F5E5A', marginBottom: 8 }}>
          已触发 Jenkins Job，等待 Jenkins 回传最终状态
        </div>
      )}

      {/* Status summary */}
      {hasTaskStats && <div style={{ display: 'flex', gap: 14, fontSize: 11, marginBottom: 10 }}>
        <span style={{ color: '#0F6E56' }}>■ 成功 {current.successCount}</span>
        <span style={{ color: '#2563EB' }}>■ 运行中 {current.runningCount}</span>
        {current.failedCount > 0 && <span style={{ color: '#DC2626' }}>■ 失败 {current.failedCount}</span>}
        {current.blockedCount > 0 && <span style={{ color: '#854F0B' }}>■ 阻断 {current.blockedCount}</span>}
        <span style={{ color: '#9C9A92' }}>■ 排队 {current.queuedCount}</span>
      </div>}

      {/* Per-project breakdown */}
      {hasTaskStats && (current.projectGroups ?? []).map((group) => (
        <div key={group.project} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', background: '#FAFAF9',
          borderRadius: 6, marginBottom: 4,
        }}>
          <button
            onClick={() => setExpandedProj((prev) =>
              prev.includes(group.project)
                ? prev.filter((p) => p !== group.project)
                : [...prev, group.project]
            )}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9C9A92', fontSize: 10 }}
          >
            {expandedProj.includes(group.project) ? <DownOutlined /> : <RightOutlined />}
          </button>
          <span style={{ fontWeight: 500, fontSize: 12, minWidth: 160 }}>{group.project}</span>
          <PipelineStatusBadge status={group.status} />
          <ProgressBar value={group.totalCount > 0 ? Math.round((group.doneCount / group.totalCount) * 100) : 0} height={5} />
          <span style={{ fontSize: 11, color: '#5F5E5A', whiteSpace: 'nowrap' }}>
            {group.doneCount}/{group.totalCount}
          </span>
          <span style={{ fontSize: 11, color: rateColor(group.passRate), minWidth: 42 }}>
            {group.status === 'pending' ? '—' : fmtRate(group.passRate)}
          </span>
        </div>
      ))}
    </Card>
  )
}
