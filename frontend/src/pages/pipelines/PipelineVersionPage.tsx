import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import {
  Button, Table, Tag, Space, Select, Drawer,
  Alert, Spin, Tooltip, message,
} from 'antd'
import {
  HistoryOutlined, DiffOutlined, RollbackOutlined,
  CheckCircleOutlined, UserOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import PageHeader from '@/components/common/PageHeader'
import { useTableLayout } from '@/hooks/useTableLayout'
import { fmtDatetime } from '@/utils/format'
import { showConfirm } from '@/components/common/ConfirmModal'

interface PipelineVersion {
  id: string
  version: number
  name: string
  changeSummary: string
  changedBy: string
  changedByName: string
  createdAt: string
  stageConfigJson: string
  dagConfigJson: string
  params: string
}

interface DiffLine {
  type: 'equal' | 'add' | 'remove'
  content: string
  lineNo: number
}

interface DiffSection {
  field: string
  label: string
  baseVal: string
  headVal: string
  changed: boolean
  lines?: DiffLine[]
}

interface DiffResult {
  baseVersion: number
  headVersion: number
  hasChanges: boolean
  sections: DiffSection[]
}

// ── Diff renderer ──────────────────────────────────────────────────────────
function DiffView({ sections }: { sections: DiffSection[] }) {
  const changed = sections.filter(s => s.changed)
  const unchanged = sections.filter(s => !s.changed)

  if (changed.length === 0) {
    return (
      <Alert
        type="info" showIcon
        message="两个版本内容完全相同，无差异"
        style={{ marginBottom: 12 }}
      />
    )
  }

  return (
    <div>
      {changed.map(sec => (
        <div key={sec.field} style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: '#1A1A18',
            marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Tag color="orange">已变更</Tag>
            {sec.label}
          </div>

          {sec.lines && sec.lines.length > 0 ? (
            <div className="atop-diff-block">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
                <tbody>
                  {sec.lines.map((line, i) => {
                    const bg = line.type === 'add' ? '#0A2D0A'
                             : line.type === 'remove' ? '#2D0A0A'
                             : 'transparent'
                    const color = line.type === 'add' ? '#3FB950'
                                : line.type === 'remove' ? '#F85149'
                                : '#8B949E'
                    const prefix = line.type === 'add' ? '+'
                                 : line.type === 'remove' ? '-'
                                 : ' '
                    return (
                      <tr key={i} style={{ background: bg }}>
                        <td style={{
                          width: 40, textAlign: 'right', padding: '0 8px',
                          color: '#484F58', userSelect: 'none', borderRight: '1px solid #21262D',
                          fontSize: 11,
                        }}>
                          {line.lineNo}
                        </td>
                        <td style={{
                          width: 20, textAlign: 'center', color,
                          fontWeight: 700, userSelect: 'none',
                        }}>
                          {prefix}
                        </td>
                        <td style={{ padding: '0 8px 0 4px', color, whiteSpace: 'pre' }}>
                          {line.content || ' '}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 11, color: '#9C9A92', marginBottom: 4 }}>原值</div>
                <div style={{
                  background: '#2D0A0A', border: '1px solid #F85149',
                  borderRadius: 6, padding: '8px 12px',
                  color: '#F85149', fontSize: 12, fontFamily: 'monospace',
                }}>
                  {sec.baseVal || '（空）'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#9C9A92', marginBottom: 4 }}>新值</div>
                <div style={{
                  background: '#0A2D0A', border: '1px solid #3FB950',
                  borderRadius: 6, padding: '8px 12px',
                  color: '#3FB950', fontSize: 12, fontFamily: 'monospace',
                }}>
                  {sec.headVal || '（空）'}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {unchanged.length > 0 && (
        <div style={{ fontSize: 12, color: '#9C9A92', marginTop: 8 }}>
          未变更字段：{unchanged.map(s => s.label).join('、')}
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function PipelineVersionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [diffOpen, setDiffOpen]   = useState(false)
  const [baseVer, setBaseVer]     = useState<number | null>(null)
  const [headVer, setHeadVer]     = useState<number | null>(null)
  const [diffData, setDiffData]   = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const { tableProps } = useTableLayout({ offsetY: 360 })

  const { data, isLoading, mutate } = useSWR(
    id ? [`/pipelines/${id}/versions`] : null,
    () => client.get(`/pipelines/${id}/versions`).then(r => r.data.data)
  )
  const versions: PipelineVersion[] = data?.items ?? []

  // Auto-select head = latest, base = second latest
  const latestVer  = versions[0]?.version ?? null
  const selectedHead = headVer ?? latestVer
  const selectedBase = baseVer ?? (versions[1]?.version ?? null)

  const loadDiff = async () => {
    if (!id || !selectedHead) return
    setDiffLoading(true)
    try {
      const params = selectedBase ? `?base=${selectedBase}` : ''
      const r = await client.get(`/pipelines/${id}/versions/${selectedHead}/diff${params}`)
      setDiffData(r.data.data)
      setDiffOpen(true)
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? 'Diff 加载失败')
    } finally {
      setDiffLoading(false)
    }
  }

  const handleRestore = (ver: number) => {
    showConfirm({
      title: `还原到 v${ver}？`,
      content: '当前配置将被覆盖，还原操作本身也会生成一个新版本快照，可随时再次回滚。',
      onOk: async () => {
        setRestoring(true)
        try {
          await client.post(`/pipelines/${id}/versions/${ver}/restore`)
          message.success(`已还原到 v${ver}`)
          mutate()
        } catch { /* handled */ } finally { setRestoring(false) }
      },
    })
  }

  const cols = [
    {
      title: '版本', dataIndex: 'version', width: 70,
      render: (v: number) => (
        <Tag color={v === latestVer ? 'blue' : 'default'}>
          {v === latestVer ? `v${v} 当前` : `v${v}`}
        </Tag>
      ),
    },
    {
      title: '变更摘要', dataIndex: 'changeSummary',
      render: (v: string) => <span style={{ fontSize: 13 }}>{v || '无描述'}</span>,
    },
    {
      title: '修改人', dataIndex: 'changedByName',
      width: 120,
      render: (v: string) => (
        <Space>
          <UserOutlined style={{ color: '#9C9A92' }} />
          <span style={{ fontSize: 12 }}>{v || '—'}</span>
        </Space>
      ),
    },
    {
      title: '时间', dataIndex: 'createdAt', width: 160,
      render: (v: string) => <span style={{ fontSize: 12, color: '#9C9A92' }}>{fmtDatetime(v)}</span>,
    },
    {
      title: '操作', key: 'action', width: 180,
      render: (_: unknown, r: PipelineVersion) => (
        <div className="atop-action-row">
          <Tooltip title="与当前版本对比">
            <Button size="small" icon={<DiffOutlined />}
              onClick={() => { setHeadVer(latestVer); setBaseVer(r.version); loadDiff() }}>
              Diff
            </Button>
          </Tooltip>
          {r.version !== latestVer && (
            <Tooltip title="还原到此版本">
              <Button size="small" icon={<RollbackOutlined />}
                loading={restoring}
                onClick={() => handleRestore(r.version)}>
                还原
              </Button>
            </Tooltip>
          )}
        </div>
      ),
    },
  ]

  if (isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>

  return (
    <div className="atop-page-shell">
      <PageHeader
        eyebrow="VERSION CONTROL"
        title={<Space><HistoryOutlined />版本历史</Space>}
        subtitle={`共 ${versions.length} 个版本快照，最多保留 50 个。支持版本 Diff 与安全回滚。`}
        extra={
          <Space>
            <Button onClick={() => navigate(-1)}>返回</Button>
            <Button
              type="primary" icon={<DiffOutlined />}
              loading={diffLoading}
              disabled={!selectedBase || selectedBase === selectedHead}
              onClick={loadDiff}
            >
              对比版本
            </Button>
          </Space>
        }
      />

      {/* Version selector */}
      <div className="atop-version-toolbar">
        <span style={{ color: '#9C9A92' }}>快速对比：</span>
        <Select
          placeholder="基准版本"
          style={{ width: 140 }}
          value={selectedBase ?? undefined}
          onChange={v => setBaseVer(v)}
          options={versions.map(v => ({
            value: v.version,
            label: `v${v.version}${v.version === latestVer ? ' (当前)' : ''}`,
          }))}
        />
        <span style={{ color: '#9C9A92' }}>→</span>
        <Select
          placeholder="目标版本"
          style={{ width: 140 }}
          value={selectedHead ?? undefined}
          onChange={v => setHeadVer(v)}
          options={versions.map(v => ({
            value: v.version,
            label: `v${v.version}${v.version === latestVer ? ' (当前)' : ''}`,
          }))}
        />
        <Button
          type="primary" ghost icon={<DiffOutlined />}
          loading={diffLoading}
          disabled={!selectedBase || !selectedHead || selectedBase === selectedHead}
          onClick={loadDiff}
        >
          查看 Diff
        </Button>
      </div>

      <div className="atop-content-card atop-table-card">
        <Table
          {...tableProps}
          rowKey="id"
          columns={cols}
          dataSource={versions}
          pagination={false}
          size="small"
        />
      </div>

      {/* Diff Drawer */}
      <Drawer
        title={
          <Space>
            <DiffOutlined />
            <span>
              v{diffData?.baseVersion ?? selectedBase}
              <span style={{ color: '#9C9A92', margin: '0 8px' }}>→</span>
              v{diffData?.headVersion ?? selectedHead}
            </span>
            {diffData && (
              diffData.hasChanges
                ? <Tag color="orange">{diffData.sections.filter(s => s.changed).length} 处变更</Tag>
                : <Tag color="green" icon={<CheckCircleOutlined />}>无差异</Tag>
            )}
          </Space>
        }
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        width={800}
        styles={{ body: { padding: '16px 20px' } }}
      >
        {diffLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : diffData ? (
          <DiffView sections={diffData.sections} />
        ) : null}
      </Drawer>
    </div>
  )
}
