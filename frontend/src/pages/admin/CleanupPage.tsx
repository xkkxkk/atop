import { useState } from 'react'
import useSWR from 'swr'
import {
  Card, InputNumber, Switch, Button, Space, Alert,
  Statistic, Row, Col, Modal, Tag,
  Tooltip, Typography, Spin,
} from 'antd'
import {
  DeleteOutlined, PlayCircleOutlined, EyeOutlined,
  InfoCircleOutlined, WarningOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import PageHeader from '@/components/common/PageHeader'
import { usePermission } from '@/hooks/usePermission'

const { Text } = Typography

interface CleanupConfig {
  runRetentionDays:    number
  auditRetentionDays:  number
  notiRetentionDays:   number
  maxRunsPerPipeline:  number
  maxAuditLogs:          number
  snapshotRetentionDays: number
  autoEnabled:           boolean
  updatedAt?:          string
}

interface CleanupStats {
  pipelineRuns:   number
  auditLogs:      number
  notifications:  number
}

interface CleanupResult {
  pipelineRunsDeleted:  number
  taskRunsDeleted:      number
  auditLogsDeleted:     number
  notificationsDeleted: number
  snapshotsCleared:     number
  duration:             string
  dryRun:               boolean
}

const fetchConfig = () =>
  client.get<{ data: { config: CleanupConfig; stats: CleanupStats } }>('/admin/cleanup')
    .then(r => r.data.data)

const NO_PERM_TIP = '无权限，请联系管理员'

// ── Config item row ────────────────────────────────────────────────────────
function ConfigRow({
  label, hint, value, onChange, unit = '天', min = 0, max = 3650, disabled = false,
}: {
  label: string; hint: string; value: number
  onChange: (v: number) => void; unit?: string; min?: number; max?: number
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 0', borderBottom: '1px solid #f5f5f5' }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#1A1A18' }}>{label}</div>
        <div style={{ fontSize: 12, color: '#9C9A92', marginTop: 2 }}>{hint}</div>
      </div>
      <Space>
        <Tooltip title={disabled ? NO_PERM_TIP : undefined}>
          <InputNumber
            value={value}
            min={min} max={max}
            onChange={v => onChange(v ?? 0)}
            style={{ width: 100 }}
            addonAfter={unit}
            disabled={disabled}
          />
        </Tooltip>
        {value === 0 && (
          <Tag color="default" style={{ fontSize: 11 }}>已禁用</Tag>
        )}
      </Space>
    </div>
  )
}

// ── Result modal ───────────────────────────────────────────────────────────
function ResultModal({
  open, result, onClose,
}: { open: boolean; result: CleanupResult | null; onClose: () => void }) {
  if (!result) return null

  const rows = [
    { label: '流水线运行记录', count: result.pipelineRunsDeleted,  color: '#2563EB' },
    { label: '任务运行记录',   count: result.taskRunsDeleted,      color: '#5B8DEF' },
    { label: '审计日志',       count: result.auditLogsDeleted,     color: '#9C9A92' },
    { label: '通知消息',       count: result.notificationsDeleted, color: '#9C9A92' },
    { label: '快照数据清空',   count: result.snapshotsCleared,     color: '#185FA5' },
  ]

  const total = result.pipelineRunsDeleted + result.taskRunsDeleted +
    result.auditLogsDeleted + result.notificationsDeleted

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={<Button type="primary" onClick={onClose}>关闭</Button>}
      title={
        <Space>
          {result.dryRun
            ? <><EyeOutlined style={{ color: '#2563EB' }} />预览清理结果</>
            : <><CheckCircleOutlined style={{ color: '#52c41a' }} />清理完成</>
          }
        </Space>
      }
      width={480}
    >
      {result.dryRun && (
        <Alert type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
          message="以下为预估清理数量，实际执行时以当时数据为准" />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between',
            padding: '10px 16px', background: '#F8F9FA', borderRadius: 8 }}>
            <span style={{ fontSize: 13, color: '#5F5E5A' }}>{r.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: r.count > 0 ? r.color : '#ccc' }}>
              {r.count.toLocaleString()}
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between',
          padding: '10px 16px', background: total > 0 ? '#FFF7E6' : '#F6FFED',
          borderRadius: 8, borderLeft: `3px solid ${total > 0 ? '#faad14' : '#52c41a'}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>合计</span>
          <span style={{ fontSize: 18, fontWeight: 800,
            color: total > 0 ? '#d46b08' : '#389e0d' }}>
            {total.toLocaleString()} 条
          </span>
        </div>
        {!result.dryRun && (
          <div style={{ textAlign: 'right', fontSize: 12, color: '#9C9A92' }}>
            耗时 {result.duration}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function CleanupPage() {
  const { data, isLoading, mutate } = useSWR('cleanup-config', fetchConfig,
    { revalidateOnFocus: false })

  const [cfg, setCfg]               = useState<CleanupConfig | null>(null)
  const [saving, setSaving]         = useState(false)
  const [running, setRunning]       = useState(false)
  const [previewResult, setPreview] = useState<CleanupResult | null>(null)
  const [execResult, setExecResult] = useState<CleanupResult | null>(null)
  const [modalOpen, setModalOpen]   = useState(false)

  const { can } = usePermission()
  const canEdit = can('cleanup', 'edit')

  const config = cfg ?? data?.config ?? null
  const stats  = data?.stats

  const setField = (field: keyof CleanupConfig) => (v: any) => {
    if (!canEdit) return
    setCfg(prev => ({ ...(prev ?? data!.config), [field]: v }))
  }

  const handleSave = async () => {
    if (!config || !canEdit) return
    setSaving(true)
    try {
      await client.put('/admin/cleanup', config)
      mutate()
      setCfg(null)
      const { message } = await import('antd')
      message.success('配置已保存，下次自动清理将使用新配置')
    } catch { /* handled */ }
    finally { setSaving(false) }
  }

  const handleDryRun = async () => {
    setRunning(true)
    try {
      const resp = await client.get<{ data: CleanupResult }>('\/admin\/cleanup\/dryrun')
      setPreview(resp.data.data)
      setModalOpen(true)
    } catch { /* handled */ }
    finally { setRunning(false) }
  }

  const handleExecute = () => {
    if (!canEdit) return
    Modal.confirm({
      title: '确认立即执行数据清理？',
      icon: <WarningOutlined style={{ color: '#faad14' }} />,
      content: '将根据当前配置立即删除数据，此操作不可撤销。建议先执行「预览」查看影响范围。',
      okText: '确认执行', cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setRunning(true)
        try {
          const resp = await client.post<{ data: CleanupResult }>('\/admin\/cleanup\/run')
          setExecResult(resp.data.data)
          setModalOpen(true)
          mutate()
        } catch { /* handled */ }
        finally { setRunning(false) }
      },
    })
  }

  if (isLoading) return (
    <div style={{ textAlign: 'center', padding: 80 }}>
      <Spin size="large" />
    </div>
  )

  return (
    <div className="atop-page-shell atop-page-shell-narrow atop-cleanup-page" style={{ maxWidth: 760 }}>
      <div className="atop-cleanup-sticky-head" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
      <PageHeader
        eyebrow="DATA HYGIENE"
        title="数据清理配置"
        subtitle="统一配置运行记录、审计日志、通知消息与快照数据的保留策略"
        extra={
          <Space>
            {/* 预览：只需 view 权限 */}
            <Tooltip title="预览将要清理的数据量，不实际删除">
              <Button icon={<EyeOutlined />} onClick={handleDryRun} loading={running}>
                预览
              </Button>
            </Tooltip>
            {/* 立即执行：需要 edit 权限 */}
            <Tooltip title={!canEdit ? NO_PERM_TIP : '立即按当前配置执行清理'}>
              <Button danger icon={<PlayCircleOutlined />}
                onClick={handleExecute} loading={running} disabled={!canEdit}>
                立即执行
              </Button>
            </Tooltip>
            {/* 保存：需要 edit 权限 */}
            <Tooltip title={!canEdit ? NO_PERM_TIP : undefined}>
              <Button type="primary" icon={<CheckCircleOutlined />}
                loading={saving} onClick={handleSave} disabled={!canEdit}>
                保存配置
              </Button>
            </Tooltip>
          </Space>
        }
      />
      </div>

      {stats && (
        <Card size="small" className="atop-content-card atop-cleanup-card" style={{ marginBottom: 16 }}
          title={<Space><InfoCircleOutlined />当前数据量</Space>}>
          <Row gutter={24}>
            {[
              { label: '运行记录', value: stats.pipelineRuns,  color: '#2563EB' },
              { label: '审计日志', value: stats.auditLogs,     color: '#9C9A92' },
              { label: '通知消息', value: stats.notifications, color: '#52c41a' },
            ].map(s => (
              <Col span={8} key={s.label}>
                <Statistic
                  title={<span style={{ fontSize: 13 }}>{s.label}</span>}
                  value={s.value}
                  valueStyle={{ fontSize: 22, fontWeight: 700, color: s.color }}
                  suffix="条"
                />
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* 自动清理：需要 edit 权限 */}
      <Card size="small" className="atop-content-card atop-cleanup-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>自动清理</div>
            <div style={{ fontSize: 12, color: '#9C9A92', marginTop: 2 }}>
              每天凌晨 3:30 自动执行清理，使用下方配置规则
            </div>
          </div>
          <Tooltip title={!canEdit ? NO_PERM_TIP : undefined}>
            <Switch
              checked={config?.autoEnabled ?? true}
              onChange={setField('autoEnabled')}
              checkedChildren="开启" unCheckedChildren="关闭"
              disabled={!canEdit}
            />
          </Tooltip>
        </div>
      </Card>

      {/* 按时间保留：InputNumber 需要 edit 权限 */}
      <Card size="small" className="atop-content-card atop-cleanup-card" style={{ marginBottom: 16 }}
        title="按时间保留（0 = 不限制）">
        {config && (
          <>
            <ConfigRow label="运行记录保留天数"
              hint="超过此天数的 pipeline_runs / task_runs 将被删除"
              value={config.runRetentionDays} onChange={setField('runRetentionDays')}
              disabled={!canEdit} />
            <ConfigRow label="审计日志保留天数"
              hint="超过此天数的审计日志将被删除"
              value={config.auditRetentionDays} onChange={setField('auditRetentionDays')}
              disabled={!canEdit} />
            <ConfigRow label="通知消息保留天数"
              hint="超过此天数的已读通知将被删除"
              value={config.notiRetentionDays} onChange={setField('notiRetentionDays')}
              disabled={!canEdit} />
            <ConfigRow label="测试集快照保留天数"
              hint="超过此天数的任务运行快照 JSON 将被清空（保留运行记录，仅清除快照数据）"
              value={config.snapshotRetentionDays} onChange={setField('snapshotRetentionDays')}
              disabled={!canEdit} />
          </>
        )}
      </Card>

      <Card size="small" className="atop-content-card atop-cleanup-card" title="按条数限制（0 = 不限制）">
        {config && (
          <>
            <ConfigRow label="每条流水线最多保留运行记录"
              hint="每条流水线只保留最近 N 次运行，超出的旧记录被删除"
              value={config.maxRunsPerPipeline} onChange={setField('maxRunsPerPipeline')}
              unit="条" disabled={!canEdit} />
            <ConfigRow label="审计日志最多保留条数"
              hint="全局审计日志超过此数量时删除最旧的记录"
              value={config.maxAuditLogs} onChange={setField('maxAuditLogs')}
              unit="条" disabled={!canEdit} />
          </>
        )}
      </Card>

      <Alert
        type="warning" showIcon style={{ marginTop: 16, fontSize: 12 }}
        icon={<WarningOutlined />}
        message="注意：数据清理操作不可恢复。建议定期备份数据库，再执行清理。"
      />

      <ResultModal
        open={modalOpen}
        result={previewResult ?? execResult}
        onClose={() => {
          setModalOpen(false)
          setPreview(null)
          setExecResult(null)
        }}
      />
    </div>
  )
}
