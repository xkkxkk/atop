import { useState } from 'react'
import { Modal, Button, message, Spin } from 'antd'
import { CopyOutlined, EyeOutlined } from '@ant-design/icons'
import { testSetApi } from '@/api/testsets'

interface Props {
  testSetId: string
  testSetName: string
}

export default function PreviewJsonModal({ testSetId, testSetName }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [json, setJson] = useState<object | null>(null)

  const handleOpen = async () => {
    setOpen(true)
    if (json) return
    setLoading(true)
    try {
      const data = await testSetApi.previewJson(testSetId)
      setJson(data)
    } catch {
      // handled by request interceptor
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = () => {
    const text = JSON.stringify(json, null, 2)
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
      message.success('已复制到剪贴板')
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        message.success('已复制到剪贴板')
      } catch {
        message.error('复制失败，请手动选择复制')
      }
      document.body.removeChild(textarea)
    }
  }

  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

  const highlight = (value: string) =>
    escapeHtml(value)
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (match) => {
          let color = 'color:#0550AE'
          if (/^"/.test(match)) {
            color = /:$/.test(match) ? 'color:#116329' : 'color:#0A3069'
          } else if (/true|false/.test(match)) {
            color = 'color:#CF222E'
          } else if (/null/.test(match)) {
            color = 'color:#8250DF'
          }
          return `<span style="${color}">${match}</span>`
        })

  return (
    <>
      <Button size="small" icon={<EyeOutlined />} onClick={handleOpen}>
        预览 JSON
      </Button>

      <Modal
        title={`JSON Payload · ${testSetName}`}
        open={open}
        onCancel={() => setOpen(false)}
        width={680}
        footer={(
          <Button.Group>
            <Button icon={<CopyOutlined />} onClick={handleCopy} disabled={!json}>复制 JSON</Button>
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Button.Group>
        )}
        styles={{ body: { padding: 0 } }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : json ? (
          <div style={{
            background: '#F6F8FA',
            borderRadius: '0 0 8px 8px',
            overflow: 'auto',
            maxHeight: 480,
          }}>
            <pre
              style={{ margin: 0, padding: '16px 20px', fontSize: 12, lineHeight: 1.7, fontFamily: 'monospace' }}
              dangerouslySetInnerHTML={{ __html: highlight(JSON.stringify(json, null, 2)) }}
            />
          </div>
        ) : null}
      </Modal>
    </>
  )
}
