import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { Card, Button, Spin, Tag, Timeline } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined, LinkOutlined, ApiOutlined, ClockCircleOutlined, ClusterOutlined } from '@ant-design/icons'
import client from '@/api/client'
import MetricCard from '@/components/common/MetricCard'
import { PipelineStatusBadge } from '@/components/common/StatusBadge'
import { fmtDuration, fmtDatetime } from '@/utils/format'
import { displayUserName } from '@/utils/userDisplay'

export default function ReportedRunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, isLoading, mutate } = useSWR(
    id ? `reported-run-${id}` : null,
    () => client.get(`/report/runs/${id}`).then(r => r.data.data ?? r.data),
    { refreshInterval: 5000 },
  )

  if (isLoading || !data) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spin /></div>
  }

  const run = data.run ?? data
  const stages: any[] = data.stages ?? []

  const statusMeta: Record<string, { color: string; label: string }> = {
    pending:  { color: '#9C9A92', label: '等待中' },
    running:  { color: '#2563EB', label: '运行中' },
    success:  { color: '#0F6E56', label: '成功' },
    failed:   { color: '#DC2626', label: '失败' },
    aborted:  { color: '#854F0B', label: '已中止' },
  }

  const statusLabel = run.status === 'success' ? '成功'
    : run.status === 'failed' ? '失败'
    : run.status === 'aborted' ? '已中止'
    : run.status === 'running' ? '运行中' : run.status

  return (
    <div className="atop-page-shell">
      <section className="atop-detail-hero">
        <div>
          <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/run-history')}>返回运行记录</Button>
          <div className="atop-detail-title" style={{ marginTop: 10 }}>
            {run.pipelineName}
            {run.buildId ? <span style={{ color: '#9C9A92', marginLeft: 8, fontSize: 13, fontWeight: 700 }}>#{run.buildId}</span> : null}
          </div>
          <div className="atop-detail-subtitle">
            <Tag icon={<ApiOutlined />} style={{ fontSize: 10 }}>Jenkins 上报</Tag>
            {run.triggeredBy && <span>触发人：{displayUserName(undefined, run.triggeredBy, '未知触发人')}</span>}
            {run.startedAt && <span> · <ClockCircleOutlined /> {fmtDatetime(run.startedAt)}</span>}
          </div>
        </div>
        <div className="atop-detail-actions">
          {run.buildUrl && (
            <Button size="small" icon={<LinkOutlined />} href={run.buildUrl} target="_blank">Jenkins 构建</Button>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => mutate()}>刷新</Button>
        </div>
      </section>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10, marginBottom: 12 }}>
        <MetricCard label="状态" value={statusLabel} color={statusMeta[run.status]?.color} />
        <MetricCard label="阶段数" value={stages.length} />
        <MetricCard label="总耗时" value={fmtDuration(run.durationMs)} />
      </div>

      {/* Status badge + error */}
      <div className="atop-status-strip" style={{ marginBottom: 10 }}>
          <PipelineStatusBadge status={run.status} />
          <span style={{ color: '#9C9A92', fontSize: 12 }}>
            {stages.filter(s => s.status === 'success').length} / {stages.length} 阶段完成
          </span>
        {run.errorSummary && (
          <div className="atop-error-note">
            {run.errorSummary}
          </div>
        )}
      </div>

      {/* Stages timeline */}
      <Card className="atop-content-card atop-stage-card" size="small" title={
        <div className="atop-stage-title"><ClusterOutlined /><span>阶段时间线</span></div>
      } styles={{ body: { padding: '16px 20px' } }}>
        {stages.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#9C9A92', padding: 24 }}>
            暂无阶段数据
          </div>
        ) : (
          <Timeline
            items={stages.map((s: any) => {
              const meta = statusMeta[s.status] ?? { color: '#9C9A92', label: s.status }
              return {
                color: meta.color,
                children: (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{s.stageName || s.stageKey}</span>
                      <Tag color={meta.color === '#0F6E56' ? 'green' : meta.color === '#DC2626' ? 'red' : meta.color === '#854F0B' ? 'orange' : meta.color === '#2563EB' ? 'blue' : 'default'} style={{ fontSize: 11 }}>
                        {meta.label}
                      </Tag>
                      {s.nodeName && <span className="atop-stage-node">节点：{s.nodeName}</span>}
                      {s.durationMs > 0 && <span style={{ fontSize: 11, color: '#9C9A92', marginLeft: 'auto' }}>{fmtDuration(s.durationMs)}</span>}
                    </div>
                    {(s.startedAt || s.finishedAt) && (
                      <div style={{ fontSize: 11, color: '#9C9A92' }}>
                        {s.startedAt && <>开始 {fmtDatetime(s.startedAt)}</>}
                        {s.finishedAt && <> · 结束 {fmtDatetime(s.finishedAt)}</>}
                      </div>
                    )}
                    {s.errorSummary && (
                      <div className="atop-error-note">
                        {s.errorSummary}
                      </div>
                    )}
                  </div>
                ),
              }
            })}
          />
        )}
      </Card>
    </div>
  )
}
