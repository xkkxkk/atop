import { useState, useCallback } from 'react'
import {
  Modal, Upload, Button, Steps, Alert, Table, Tag, Space,
  Divider, Typography, Tooltip, Badge, Spin, message, Radio,
} from 'antd'
import {
  InboxOutlined, FileTextOutlined, CheckCircleOutlined,
  CloseCircleOutlined, PlusCircleOutlined, SyncOutlined,
  WarningOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import client from '@/api/client'

const { Dragger } = Upload
const { Text, Title } = Typography

// ── Types ─────────────────────────────────────────────────────────────────
interface NewDimensionItem {
  dimension: string
  value: string
  displayName: string
}

interface PreviewSample {
  name: string
  project: string
  environment: string
  product: string
  agentLabel: string
  isNew: boolean
}

interface ParseError {
  index: number
  name: string
  reason: string
}

interface ImportPreview {
  total: number
  newTestSets: number
  updateTestSets: number
  newDimensions: NewDimensionItem[]
  samples: PreviewSample[]
  parseErrors: ParseError[]
}

interface ImportResult {
  total: number
  success: number
  failed: number
  skipped: number
  errors: ParseError[]
  duration: string
}

interface Props {
  open: boolean
  onClose: () => void
  onDone: () => void
}

// ── Dimension label map ────────────────────────────────────────────────────
const DIM_LABELS: Record<string, { label: string; color: string }> = {
  project:     { label: '项目',     color: 'blue'   },
  environment: { label: '环境',     color: 'cyan'   },
  product:     { label: '产品形态', color: 'purple' },
  silicon:     { label: 'Silicon',  color: 'orange' },
  os:          { label: '系统(OS)', color: 'geekblue'},
  run_type:    { label: '类型',     color: 'volcano'},
}

const EXAMPLE_JSON = JSON.stringify([
  {
    name: '驱动集成测试_ubuntu_ASIC',
    project: 'V3_SOFTWARE_master',
    environment: 'UBUNTU',
    product: 'CMODEL',
    agentLabel: 'V3_CMODEL',
    silicon: 'ASIC',
    os: 'ubuntu',
    run_type: 'DAILY',
    branch: 'master',
    priority: 10,
    stage_num: 1,
    exec_cmd: [{ cmdlabel: 'run_test', use_docker: 'true', cmd: 'bash run_test.sh' }],
  },
], null, 2)

// Field notes shown in UI
const FIELD_NOTES = [
  { field: 'name',        required: true,  desc: '测试集名称（可自定义，唯一标识）' },
  { field: 'project',     required: true,  desc: '所属项目' },
  { field: 'environment', required: false, desc: '环境（如 UBUNTU / WINDOWS）' },
  { field: 'product',     required: false, desc: '产品形态' },
  { field: 'agentLabel',  required: true,  desc: 'Jenkins Agent 标签' },
  { field: 'exec_cmd',    required: true,  desc: '执行命令列表' },
]

export default function BatchImportModal({ open, onClose, onDone }: Props) {
  const [step, setStep]         = useState(0)
  const [files, setFiles]       = useState<File[]>([])
  const [mode, setMode]         = useState<'skip' | 'upsert'>('skip')
  const [preview, setPreview]   = useState<ImportPreview | null>(null)
  const [result, setResult]     = useState<ImportResult | null>(null)
  const [loading, setLoading]   = useState(false)
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({})

  const reset = useCallback(() => {
    setStep(0); setFiles([]); setPreview(null); setResult(null); setLoading(false); setNameOverrides({})
  }, [])

  const handleClose = useCallback(() => {
    if (step === 1 && files.length > 0 && !preview) {
      Modal.confirm({
        title: '确认放弃？',
        content: '已选择文件，关闭后需重新选择。',
        okText: '放弃', cancelText: '继续',
        okButtonProps: { danger: true },
        onOk: () => { reset(); onClose() },
      })
      return
    }
    reset(); onClose()
  }, [step, files, preview, reset, onClose])

  // ── Step 1: Parse & Preview ─────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    if (files.length === 0) return
    setLoading(true)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const resp = await client.post('/test-sets/import/preview', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setPreview(resp.data.data as ImportPreview)
      setStep(2)
    } catch (err: any) {
      message.error(err?.response?.data?.message || '解析失败，请检查文件格式')
    } finally {
      setLoading(false)
    }
  }, [files])

  // ── Step 2: Confirm & Import ────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!preview) return
    setLoading(true)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      if (Object.keys(nameOverrides).length > 0) {
        form.append('nameOverrides', JSON.stringify(nameOverrides))
      }
      const resp = await client.post(`/test-sets/import?mode=${mode}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(resp.data.data as ImportResult)
      setStep(3)
      if ((resp.data.data as ImportResult).success > 0) onDone()
    } catch (err: any) {
      message.error(err?.response?.data?.message || '导入失败')
    } finally {
      setLoading(false)
    }
  }, [files, mode, preview, onDone])

  // ── File selection ──────────────────────────────────────────────────────
  const handleFileAdd = useCallback((file: File) => {
    if (!file.name.endsWith('.json')) {
      message.warning(`${file.name} 不是 JSON 文件，已跳过`)
      return false
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string
        const data = JSON.parse(text)
        const baseName = file.name.replace(/\.json$/i, '')
        
        if (Array.isArray(data)) {
          data.forEach((item, idx) => {
            if (typeof item === 'object' && item !== null) {
              item.name = data.length === 1 ? baseName : `${baseName}_${idx + 1}`
            }
          })
        } else if (typeof data === 'object' && data !== null) {
          data.name = baseName
        }
        
        const newFile = new File([JSON.stringify(data, null, 2)], file.name, { type: 'application/json' })
        setFiles(prev => {
          const exists = prev.some(f => f.name === newFile.name && f.size === newFile.size)
          if (exists) { message.warning(`${file.name} 已添加`); return prev }
          return [...prev, newFile]
        })
      } catch {
        // Fallback on error
        setFiles(prev => {
          const exists = prev.some(f => f.name === file.name && f.size === file.size)
          if (exists) { message.warning(`${file.name} 已添加`); return prev }
          return [...prev, file]
        })
      }
    }
    reader.onerror = () => {
      setFiles(prev => [...prev, file])
    }
    reader.readAsText(file)

    return false // prevent auto-upload
  }, [])

  const removeFile = useCallback((idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const fmtSize = (b: number) => b < 1024 ? `${b}B` : b < 1024*1024 ? `${(b/1024).toFixed(1)}KB` : `${(b/1024/1024).toFixed(1)}MB`

  // ── Render ──────────────────────────────────────────────────────────────
  const stepItems = [
    { title: '选择文件' },
    { title: '预览确认' },
    { title: '导入结果' },
  ]

  const footerButtons = () => {
    if (step === 0) return [
      <Button key="cancel" onClick={handleClose}>取消</Button>,
      <Button key="next" type="primary" disabled={files.length === 0}
        loading={loading} onClick={handlePreview}>
        解析预览 →
      </Button>,
    ]
    if (step === 2) return [
      <Button key="back" onClick={() => { setStep(0); setPreview(null) }}>← 重新选择</Button>,
      <Button key="import" type="primary" loading={loading} onClick={handleImport}>
        确认导入 {preview ? `(${preview.newTestSets + preview.updateTestSets} 条)` : ''}
      </Button>,
    ]
    return [
      <Button key="close" type="primary" onClick={() => { reset(); onClose() }}>完成</Button>,
    ]
  }

  return (
    <Modal
      title="批量导入测试集"
      open={open}
      onCancel={handleClose}
      maskClosable={false}
      width={760}
      footer={<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 12, color: '#9C9A92' }}>
          支持公司内部格式 & ATOP 原生格式，可同时上传多个文件
        </Text>
        <Space>{footerButtons()}</Space>
      </div>}
      destroyOnClose
    >
      <Steps current={step} size="small" items={stepItems} style={{ marginBottom: 20 }} />

      {/* ── Step 0: Select files ──────────────────────────────────── */}
      {step === 0 && (
        <div>
          <Dragger
            multiple
            accept=".json"
            beforeUpload={handleFileAdd}
            showUploadList={false}
            style={{ marginBottom: 12 }}
          >
            <p style={{ fontSize: 32, color: '#9C9A92', margin: '8px 0' }}>
              <InboxOutlined />
            </p>
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 4px' }}>
              点击或拖拽 JSON 文件到此处
            </p>
            <p style={{ fontSize: 12, color: '#9C9A92' }}>
              支持多个文件同时上传，系统会自动合并处理
            </p>
          </Dragger>

          {/* File list */}
          {files.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                fontSize: 12, color: '#9C9A92', marginBottom: 6 }}>
                <span>已选 {files.length} 个文件，共 {fmtSize(totalSize)}</span>
                <Button type="link" size="small" danger onClick={() => setFiles([])}>清空</Button>
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto',
                border: '1px solid #f0f0f0', borderRadius: 8 }}>
                {files.map((f, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px',
                    borderBottom: i < files.length - 1 ? '1px solid #f5f5f5' : undefined,
                  }}>
                    <FileTextOutlined style={{ color: '#2563EB', fontSize: 14 }} />
                    <Text style={{ flex: 1, fontSize: 13 }} ellipsis={{ tooltip: f.name }}>{f.name}</Text>
                    <Text style={{ fontSize: 11, color: '#9C9A92' }}>{fmtSize(f.size)}</Text>
                    <Button type="text" size="small" danger
                      onClick={() => removeFile(i)} style={{ padding: '0 4px' }}>×</Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Example */}
          <Divider style={{ margin: '10px 0 8px', fontSize: 12, color: '#9C9A92' }}>
            支持格式示例
          </Divider>
          <div style={{ position: 'relative' }}>
            <Button size="small"
              style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
              onClick={() => { navigator.clipboard.writeText(EXAMPLE_JSON); message.success('已复制') }}>
              复制示例
            </Button>
            <pre style={{
              background: '#F6F8FA', borderRadius: 8, padding: '12px 14px',
              fontSize: 11, maxHeight: 160, overflow: 'auto',
              fontFamily: 'monospace', margin: 0, color: '#24292F',
            }}>{EXAMPLE_JSON}</pre>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: '#5F5E5A', fontWeight: 500, marginBottom: 6 }}>字段说明</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FIELD_NOTES.map(n => (
                <div key={n.field} style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 4,
                  background: n.required ? '#EFF6FF' : '#F5F5F4',
                  border: `1px solid ${n.required ? '#BFDBFE' : '#E5E5E3'}`,
                }}>
                  <code style={{ color: n.required ? '#1D4ED8' : '#5F5E5A' }}>{n.field}</code>
                  <span style={{ color: '#9C9A92', marginLeft: 4 }}>{n.desc}</span>
                  {n.required && <span style={{ color: '#DC2626', marginLeft: 2 }}>*</span>}
                </div>
              ))}
            </div>
          </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Preview ───────────────────────────────────────── */}
      {step === 2 && preview && (
        <div>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
            {[
              { label: '解析总数',   value: preview.total,          color: '#5F5E5A', icon: <InfoCircleOutlined /> },
              { label: '新建',       value: preview.newTestSets,    color: '#0F6E56', icon: <PlusCircleOutlined /> },
              { label: '更新',       value: preview.updateTestSets, color: '#185FA5', icon: <SyncOutlined /> },
              { label: '解析错误',   value: (preview.parseErrors ?? []).length, color: (preview.parseErrors ?? []).length > 0 ? '#A32D2D' : '#9C9A92', icon: <WarningOutlined /> },
            ].map(s => (
              <div key={s.label} style={{
                background: '#F8F9FA', borderRadius: 10, padding: '12px 16px',
                border: `1px solid #f0f0f0`, textAlign: 'center',
              }}>
                <div style={{ fontSize: 11, color: '#9C9A92', marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* New dimensions alert */}
          {(preview.newDimensions ?? []).length > 0 && (
            <Alert
              type="warning"
              showIcon
              icon={<PlusCircleOutlined />}
              style={{ marginBottom: 12 }}
              message={
                <div>
                  <div style={{ fontWeight: 500, marginBottom: 6 }}>
                    将自动新增 {preview.newDimensions.length} 个数据字典项
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(preview.newDimensions ?? []).map((d, i) => {
                      const cfg = DIM_LABELS[d.dimension] ?? { label: d.dimension, color: 'default' }
                      return (
                        <Tooltip key={i} title={`维度：${cfg.label}`}>
                          <Tag color={cfg.color} style={{ fontSize: 12 }}>
                            {cfg.label}: {d.value}
                          </Tag>
                        </Tooltip>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: '#9C9A92', marginTop: 6 }}>
                    导入完成后可在「数据字典」中管理这些项目
                  </div>
                </div>
              }
            />
          )}

          {/* Parse errors */}
          {(preview.parseErrors ?? []).length > 0 && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }}
              message={`${preview.parseErrors.length} 条解析失败，将被跳过`}
              description={
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12 }}>
                  {(preview.parseErrors ?? []).slice(0, 3).map((e, i) => (
                    <li key={i}>第 {e.index + 1} 条 {e.name ? `「${e.name}」` : ''}: {e.reason}</li>
                  ))}
                  {(preview.parseErrors ?? []).length > 3 && (
                    <li>... 共 {(preview.parseErrors ?? []).length} 条错误</li>
                  )}
                </ul>
              }
            />
          )}

          {/* Sample preview */}
          {(preview.samples ?? []).length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#5F5E5A', marginBottom: 8 }}>
                数据预览（前 {(preview.samples ?? []).length} 条）
              </div>
              <Table
                size="small"
                pagination={false}
                dataSource={preview.samples ?? []}
                rowKey={(r, i) => `${r.project}-${r.name}-${i}`}
                columns={[
                  {
                    title: '状态', width: 70,
                    render: (_: unknown, r: PreviewSample) => r.isNew
                      ? <Badge status="success" text={<span style={{ fontSize: 11, color: '#0F6E56' }}>新建</span>} />
                      : <Badge status="processing" text={<span style={{ fontSize: 11, color: '#185FA5' }}>更新</span>} />,
                  },
                  {
                    title: (
                      <span>
                        测试集名称
                        <span style={{ fontSize: 11, color: '#9C9A92', fontWeight: 400, marginLeft: 4 }}>（可点击修改）</span>
                      </span>
                    ),
                    dataIndex: 'name', key: 'name',
                    render: (v: string) => {
                      const overrideName = nameOverrides[v] ?? v
                      return (
                        <input
                          value={overrideName}
                          onChange={e => setNameOverrides(prev => ({ ...prev, [v]: e.target.value }))}
                          style={{
                            width: '100%', minWidth: 160, maxWidth: 260,
                            border: nameOverrides[v] ? '1px solid #2563EB' : '1px solid transparent',
                            borderRadius: 4, padding: '2px 6px', fontSize: 12,
                            background: nameOverrides[v] ? '#EFF6FF' : 'transparent',
                            outline: 'none', cursor: 'text',
                            transition: 'border-color 0.15s, background 0.15s',
                          }}
                          onFocus={e => { e.target.style.borderColor = '#2563EB'; e.target.style.background = '#EFF6FF' }}
                          onBlur={e => {
                            if (!nameOverrides[v] || nameOverrides[v] === v) {
                              e.target.style.borderColor = 'transparent'
                              e.target.style.background = 'transparent'
                            }
                          }}
                          title="点击可修改测试集名称"
                        />
                      )
                    }
                  },
                  { title: '项目', dataIndex: 'project', key: 'project', width: 130,
                    render: (v: string) => <Tag color="blue" style={{ fontSize: 11 }}>{v}</Tag> },
                  { title: '环境', dataIndex: 'environment', key: 'env', width: 90,
                    render: (v: string) => v ? <Tag style={{ fontSize: 11 }}>{v}</Tag> : <span style={{ color: '#ccc' }}>-</span> },
                  { title: 'Agent', dataIndex: 'agentLabel', key: 'agent', width: 110,
                    render: (v: string) => <Text style={{ fontSize: 11 }}>{v}</Text> },
                ]}
                scroll={{ y: 160 }}
                style={{ borderRadius: 8, overflow: 'hidden' }}
              />
            </>
          )}

          {/* Import mode */}
          <div style={{ marginTop: 14, padding: '12px 16px', background: '#F8F9FA', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>重复处理方式</div>
            <Radio.Group value={mode} onChange={e => setMode(e.target.value)} size="small">
              <Space direction="vertical" size={6}>
                <Radio value="skip">
                  <span style={{ fontSize: 13 }}>跳过 </span>
                  <span style={{ fontSize: 12, color: '#9C9A92' }}>— 已存在的测试集不作修改（推荐）</span>
                </Radio>
                <Radio value="upsert">
                  <span style={{ fontSize: 13 }}>覆盖更新 </span>
                  <span style={{ fontSize: 12, color: '#9C9A92' }}>— 已存在的测试集用新配置覆盖</span>
                </Radio>
              </Space>
            </Radio.Group>
          </div>
        </div>
      )}

      {/* Loading overlay */}
      {loading && step !== 3 && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 12, color: '#9C9A92', fontSize: 13 }}>
            {step === 0 ? '正在解析文件...' : '正在导入数据...'}
          </div>
        </div>
      )}

      {/* ── Step 3: Result ────────────────────────────────────────── */}
      {step === 3 && result && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
            {[
              { label: '总计',   value: result.total,   color: '#5F5E5A' },
              { label: '成功',   value: result.success, color: '#0F6E56' },
              { label: '失败',   value: result.failed,  color: result.failed > 0 ? '#A32D2D' : '#9C9A92' },
              { label: '跳过',   value: result.skipped, color: '#9C9A92' },
            ].map(s => (
              <div key={s.label} style={{
                background: '#F8F9FA', borderRadius: 10, padding: '12px 0',
                textAlign: 'center', border: '1px solid #f0f0f0',
              }}>
                <div style={{ fontSize: 11, color: '#9C9A92', marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {result.success > 0 && (
            <Alert type="success" showIcon icon={<CheckCircleOutlined />}
              message={`成功导入 ${result.success} 条测试集，耗时 ${result.duration}`}
              style={{ marginBottom: 10 }} />
          )}

          {result.errors.length > 0 && (
            <>
              <Alert type="error" showIcon icon={<CloseCircleOutlined />}
                message={`${result.errors.length} 条导入失败`}
                style={{ marginBottom: 8 }} />
              <Table
                size="small"
                dataSource={result.errors}
                rowKey="index"
                pagination={false}
                scroll={{ y: 160 }}
                columns={[
                  { title: '#', dataIndex: 'index', width: 50,
                    render: (n: number) => <span style={{ color: '#9C9A92' }}>{n + 1}</span> },
                  { title: '名称', dataIndex: 'name', key: 'name',
                    render: (v: string) => <Text style={{ fontSize: 12 }}>{v || '—'}</Text> },
                  { title: '失败原因', dataIndex: 'reason',
                    render: (v: string) => <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> },
                ]}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
