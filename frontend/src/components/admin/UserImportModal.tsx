import { useState } from 'react'
import { Modal, Upload, Button, Alert, Table, Steps, Divider, Typography, message } from 'antd'
import { InboxOutlined, DownloadOutlined } from '@ant-design/icons'
import client from '@/api/client'

const { Dragger } = Upload
const { Text } = Typography

interface ImportError { row: number; reason: string }
interface ImportResult {
  total: number; success: number; failed: number
  errors: ImportError[]; note: string
}

interface Props { open: boolean; onClose: () => void; onDone: () => void }

const CSV_TEMPLATE = `\uFEFFusername,email,roles,projects,status
张三,zhangsan@company.com,member,V3_SOFTWARE_master;V2_SOFTWARE,active
李四,lisi@company.com,project_manager,,active
王五,wangwu@company.com,viewer;member,V3_SOFTWARE_master,disabled
说明：密码不用填写，系统统一初始化为 #PassW0rd；roles 可填 super_admin/project_manager/member/viewer，多个用 ; 分隔；projects 按系统已有项目编码填写，多个用 ; 分隔；status 为 active/disabled。,,,,`

export default function UserImportModal({ open, onClose, onDone }: Props) {
  const [step, setStep]         = useState(0)
  const [file, setFile]         = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult]     = useState<ImportResult | null>(null)

  const reset = () => { setStep(0); setFile(null); setResult(null) }
  const handleClose = () => { reset(); onClose() }

  const handleImport = async () => {
    if (!file) return
    setImporting(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const resp = await client.post('/admin/users/batch-import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(resp.data.data)
      setStep(2)
      if (resp.data.data.success > 0) onDone()
    } catch { /* handled */ }
    finally { setImporting(false) }
  }

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'atop_users_template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const errorCols = [
    { title: '行号', dataIndex: 'row', key: 'row', width: 70 },
    { title: '错误原因', dataIndex: 'reason', key: 'reason',
      render: (r: string) => <Text type="danger" style={{ fontSize: 12 }}>{r}</Text> },
  ]

  return (
    <Modal title="批量导入用户" open={open} onCancel={handleClose}
      width={600} footer={null} destroyOnClose>
      <Steps current={step} size="small" style={{ marginBottom: 24 }}
        items={[{ title: '上传文件' }, { title: '确认' }, { title: '结果' }]} />

      {step === 0 && (
        <div>
          <Alert type="info" showIcon style={{ marginBottom: 16, fontSize: 13 }}
            message={
              <div>
                CSV 格式：<code>username, email, roles, projects, status</code>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  <li>roles 可选：<code>super_admin / project_manager / member / viewer</code>，多个用 <code>;</code> 分隔</li>
                  <li>projects 填系统已有项目编码，多个用 <code>;</code> 分隔，留空表示全部项目</li>
                  <li>status 填 <code>active</code> 或 <code>disabled</code>；初始密码统一为 <code>#PassW0rd</code></li>
                </ul>
              </div>
            }
          />
          <Button icon={<DownloadOutlined />} size="small"
            style={{ marginBottom: 12 }} onClick={downloadTemplate}>
            下载模板
          </Button>
          <Dragger accept=".csv" beforeUpload={(f) => { setFile(f); setStep(1); return false }}
            showUploadList={false}>
            <p style={{ fontSize: 24, color: '#9C9A92', margin: '8px 0' }}><InboxOutlined /></p>
            <p style={{ fontSize: 14, fontWeight: 500 }}>点击或拖拽 CSV 文件</p>
            <p style={{ fontSize: 12, color: '#9C9A92' }}>仅支持 .csv 格式</p>
          </Dragger>
        </div>
      )}

      {step === 1 && file && (
        <div>
          <Alert type="success" showIcon message={`已选择：${file.name}`}
            style={{ marginBottom: 16 }} />
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ color: '#5F5E5A', fontSize: 13, marginBottom: 20 }}>
            点击「开始导入」后系统将逐行处理，跳过邮箱重复的记录。
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => { setStep(0); setFile(null) }}>重新选择</Button>
            <Button type="primary" loading={importing} onClick={handleImport}>开始导入</Button>
          </div>
        </div>
      )}

      {step === 2 && result && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
            {[
              { label: '总计', value: result.total, color: '#5F5E5A' },
              { label: '成功', value: result.success, color: '#0F6E56' },
              { label: '失败', value: result.failed, color: '#A32D2D' },
            ].map(s => (
              <div key={s.label} style={{ background: '#F5F5F4', borderRadius: 10,
                padding: '12px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#9C9A92' }}>{s.label}</div>
                <div style={{ fontSize: 24, fontWeight: 600, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {result.note && (
            <Alert type="info" showIcon message={result.note} style={{ marginBottom: 12 }} />
          )}

          {result.errors?.length > 0 && (
            <Table dataSource={result.errors} columns={errorCols}
              rowKey="row" size="small" pagination={false} scroll={{ y: 180 }} />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button type="primary" onClick={handleClose}>完成</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
