import { useMemo, useRef, useState } from 'react'
import { Button, Empty, Input, Modal, Progress, Segmented, Select, Space, Tag, message } from 'antd'
import {
  CloudSyncOutlined, FileImageOutlined, FileMarkdownOutlined, FilePdfOutlined,
  FilePptOutlined, FileTextOutlined, FileWordOutlined, LinkOutlined,
  SearchOutlined, UploadOutlined,
} from '@ant-design/icons'
import PageHeader from '@/components/common/PageHeader'

type DocumentSource = 'feishu' | 'link' | 'upload'
type DocumentKind = 'feishu' | 'pdf' | 'word' | 'ppt' | 'markdown' | 'image' | 'link'

type LibraryDocument = {
  id: string
  title: string
  source: DocumentSource
  kind: DocumentKind
  owner: string
  updatedAt: string
  size: string
  pages: string[]
  status: 'synced' | 'local' | 'linked'
  previewUrl?: string
  renderMode?: 'text' | 'image' | 'embed' | 'unsupported'
}

const KIND_LABEL: Record<DocumentKind, string> = {
  feishu: '飞书',
  pdf: 'PDF',
  word: 'Word',
  ppt: 'PPT',
  markdown: 'MD',
  image: '图片',
  link: '网页',
}

const SOURCE_LABEL: Record<DocumentSource, string> = {
  feishu: '飞书',
  link: '外链',
  upload: '上传',
}

const SEED_DOCUMENTS: LibraryDocument[] = [
  {
    id: 'doc-feishu-release',
    title: 'ATOP 发布手册',
    source: 'feishu',
    kind: 'feishu',
    owner: '平台治理组',
    updatedAt: '2026-05-21 22:30',
    size: '18 页',
    status: 'synced',
    renderMode: 'text',
    pages: [
      '发布前检查\n确认前端 dist、后端版本接口、数据库迁移和 Jenkins 连接状态均已准备完成。',
      '发布步骤\n按环境顺序发布后端、刷新前端静态资源，并观察运行大盘和审计日志。',
      '回滚预案\n保留上一版构建产物、镜像标签和配置快照，异常时按服务维度回退。',
      '验收清单\n版本中心、通知规则、流水线触发、运行记录和权限入口都需要完成冒烟检查。',
    ],
  },
  {
    id: 'doc-pipeline-guide',
    title: '流水线接入规范',
    source: 'upload',
    kind: 'pdf',
    owner: 'DevOps',
    updatedAt: '2026-05-20 18:10',
    size: 'PDF · 2.4 MB',
    status: 'local',
    renderMode: 'text',
    pages: [
      '接入范围\n统一流水线参数、凭证引用、Shared Library 和环境变量命名。',
      'Jenkinsfile 约定\n入口阶段保持可观测，关键节点必须回传运行状态。',
      '质量门禁\n单元测试、扫描和部署审批需要进入平台审计链路。',
    ],
  },
  {
    id: 'doc-release-slides',
    title: '版本发布汇报',
    source: 'upload',
    kind: 'ppt',
    owner: '产品运营',
    updatedAt: '2026-05-20 15:35',
    size: 'PPT · 16 页',
    status: 'local',
    renderMode: 'text',
    pages: [
      '本月发布概览\n功能交付、稳定性修复、平台体验优化和后续规划。',
      '关键指标\n发布频次提升 22%，流水线失败定位时间下降 31%。',
      '演示路径\n版本中心、文档中心、运行大盘和 Jenkins Agent 资源视图。',
    ],
  },
  {
    id: 'doc-word-acceptance',
    title: '验收记录模板',
    source: 'upload',
    kind: 'word',
    owner: '项目管理',
    updatedAt: '2026-05-20 11:20',
    size: 'Word · 9 页',
    status: 'local',
    renderMode: 'text',
    pages: [
      '验收结论\n记录版本范围、验收人、环境信息和上线窗口。',
      '功能验收\n逐项确认需求、截图、日志和异常说明。',
      '遗留事项\n明确负责人、完成时间和跟踪方式。',
    ],
  },
  {
    id: 'doc-md-api',
    title: '版本接口说明',
    source: 'upload',
    kind: 'markdown',
    owner: '后端服务',
    updatedAt: '2026-05-19 16:05',
    size: 'Markdown · 12 KB',
    status: 'local',
    renderMode: 'text',
    pages: [
      '# /api/version\n返回前后端版本、构建时间、提交标识和变更摘要。',
      '## 字段\nversion、latest、buildTime、commit、features、changes。',
      '## 缓存\n版本接口不建议强缓存，前端静态 version.json 使用 no-store 拉取。',
    ],
  },
  {
    id: 'doc-runbook',
    title: '异常处理 Runbook',
    source: 'link',
    kind: 'link',
    owner: 'SRE',
    updatedAt: '2026-05-19 09:45',
    size: '在线文档',
    status: 'linked',
    renderMode: 'text',
    pages: [
      '告警分级\nP0 立即处理，P1 需要 30 分钟内响应，P2 进入日常排期。',
      '定位路径\n先看运行详情，再看 Jenkins 回执，最后核对 Agent 和环境配置。',
      '复盘记录\n所有用户可见故障需要沉淀原因、影响范围和改进动作。',
    ],
  },
]

function sourceTagColor(source: DocumentSource) {
  if (source === 'feishu') return 'blue'
  if (source === 'upload') return 'green'
  return 'purple'
}

function kindIcon(kind: DocumentKind) {
  if (kind === 'pdf') return <FilePdfOutlined />
  if (kind === 'word') return <FileWordOutlined />
  if (kind === 'ppt') return <FilePptOutlined />
  if (kind === 'markdown') return <FileMarkdownOutlined />
  if (kind === 'image') return <FileImageOutlined />
  return <FileTextOutlined />
}

function inferKind(fileName: string): DocumentKind {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (ext === 'ppt' || ext === 'pptx') return 'ppt'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext ?? '')) return 'image'
  return 'link'
}

function renderPageText(text: string, kind: DocumentKind) {
  return text.split('\n').map((line) => (
    <p key={line} className={kind === 'markdown' && line.startsWith('#') ? 'is-md-heading' : undefined}>{line}</p>
  ))
}

function renderDocumentPage(doc: LibraryDocument, text: string, side: 'left' | 'right') {
  if (doc.renderMode === 'image' && doc.previewUrl) {
    return (
      <div className="atop-doc-image-preview">
        <img src={doc.previewUrl} alt={doc.title} />
      </div>
    )
  }
  if (doc.renderMode === 'unsupported') {
    return (
      <div className="atop-doc-render-note">
        {renderPageText(text, doc.kind)}
      </div>
    )
  }
  if (!text && side === 'right') {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="已到末页" />
  }
  return renderPageText(text, doc.kind)
}

function xmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function splitTextPages(text: string, pageSize = 520) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return ['未解析到可预览文本\n该文件可能主要由图片、表格或复杂版式组成，需要后端转码后完整预览。']
  const pages: string[] = []
  for (let index = 0; index < clean.length; index += pageSize) {
    pages.push(clean.slice(index, index + pageSize))
  }
  return pages
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x05 &&
      bytes[index + 3] === 0x06
    ) return index
  }
  return -1
}

async function inflateRaw(bytes: Uint8Array) {
  const Decompression = (window as any).DecompressionStream
  if (!Decompression) throw new Error('当前浏览器不支持本地解压预览')
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const stream = new Blob([buffer]).stream().pipeThrough(new Decompression('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readZipTextEntries(file: File, matcher: (name: string) => boolean) {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw new Error('未找到 Office 文档结构')
  const entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder('utf-8')
  const result: Array<{ name: string; text: string }> = []

  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + fileNameLength))
    offset += 46 + fileNameLength + extraLength + commentLength
    if (!matcher(name)) continue

    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.slice(dataStart, dataStart + compressedSize)
    const data = method === 0 ? compressed : await inflateRaw(compressed)
    result.push({ name, text: decoder.decode(data) })
  }
  return result
}

async function parseOfficeFile(file: File, kind: DocumentKind) {
  if (kind === 'word') {
    const entries = await readZipTextEntries(file, (name) => name === 'word/document.xml')
    const text = xmlText(entries[0]?.text ?? '')
    return splitTextPages(text, 560)
  }
  if (kind === 'ppt') {
    const entries = await readZipTextEntries(file, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    return entries
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((entry, index) => `第 ${index + 1} 页\n${xmlText(entry.text)}`)
      .filter((page) => page.trim().length > 4)
  }
  return []
}

export default function DocumentCenterPage() {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [documents, setDocuments] = useState(SEED_DOCUMENTS)
  const [selectedId, setSelectedId] = useState(SEED_DOCUMENTS[0]?.id ?? '')
  const [keyword, setKeyword] = useState('')
  const [sourceFilter, setSourceFilter] = useState<DocumentSource | 'all'>('all')
  const [pageIndex, setPageIndex] = useState(0)
  const [turning, setTurning] = useState<'next' | 'prev' | ''>('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectType, setConnectType] = useState<DocumentSource>('feishu')
  const [connectTitle, setConnectTitle] = useState('')
  const [connectUrl, setConnectUrl] = useState('')

  const filteredDocuments = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return documents.filter((item) => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false
      if (!query) return true
      return [item.title, item.owner, SOURCE_LABEL[item.source], KIND_LABEL[item.kind]].join(' ').toLowerCase().includes(query)
    })
  }, [documents, keyword, sourceFilter])

  const selected = documents.find((item) => item.id === selectedId) ?? filteredDocuments[0] ?? documents[0]
  const totalPages = selected?.pages.length ?? 0
  const leftPage = selected?.pages[pageIndex] ?? ''
  const rightPage = selected?.pages[pageIndex + 1] ?? ''
  const progress = totalPages > 0 ? Math.min(100, Math.round(((pageIndex + 1) / totalPages) * 100)) : 0

  const selectDocument = (id: string) => {
    setSelectedId(id)
    setPageIndex(0)
    setTurning('')
  }

  const turnPage = (direction: 'next' | 'prev') => {
    if (!selected || turning) return
    const nextIndex = direction === 'next'
      ? Math.min(pageIndex + 2, Math.max(0, totalPages - 1))
      : Math.max(pageIndex - 2, 0)
    if (nextIndex === pageIndex) return
    setTurning(direction)
    window.setTimeout(() => {
      setPageIndex(nextIndex)
      setTurning('')
    }, 560)
  }

  const addLinkedDocument = () => {
    const title = connectTitle.trim()
    const url = connectUrl.trim()
    if (!title || !url) {
      message.warning('请填写文档名称和连接地址')
      return
    }
    const next: LibraryDocument = {
      id: `doc-${Date.now()}`,
      title,
      source: connectType,
      kind: connectType === 'feishu' ? 'feishu' : 'link',
      owner: connectType === 'feishu' ? '飞书空间' : '外部来源',
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      size: connectType === 'feishu' ? '待同步' : '在线文档',
      status: connectType === 'feishu' ? 'synced' : 'linked',
      renderMode: 'text',
      pages: [
        `${title}\n该文档已通过${SOURCE_LABEL[connectType]}连接加入文档中心。`,
        `连接地址\n${url}`,
        '性能策略\n正式接入后按页拉取内容，只缓存当前页、前后相邻页和缩略信息。',
      ],
    }
    setDocuments((prev) => [next, ...prev])
    selectDocument(next.id)
    setConnectOpen(false)
    setConnectTitle('')
    setConnectUrl('')
    message.success('文档连接已添加')
  }

  const handleUploadFile = async (file?: File) => {
    if (!file) return
    const kind = inferKind(file.name)
    const ext = file.name.split('.').pop()?.toLowerCase()
    let pages: string[] = []
    let previewUrl: string | undefined
    let renderMode: LibraryDocument['renderMode'] = 'text'

    try {
      if (kind === 'markdown' || ext === 'txt') {
        pages = splitTextPages(await file.text(), kind === 'markdown' ? 620 : 720)
      } else if (kind === 'image') {
        previewUrl = URL.createObjectURL(file)
        renderMode = 'image'
        pages = [`${file.name}\n图片已在当前页真实预览。`]
      } else if ((kind === 'word' && ext === 'docx') || (kind === 'ppt' && ext === 'pptx')) {
        pages = await parseOfficeFile(file, kind)
        if (pages.length === 0) {
          renderMode = 'unsupported'
          pages = [`${file.name}\n未解析到可预览文本。该文件可能包含复杂版式、图片或受保护内容，需要后端转码后完整渲染。`]
        }
      } else if (kind === 'pdf') {
        renderMode = 'unsupported'
        pages = [`${file.name}\nPDF 文件已识别，但当前前端包未引入 pdf.js。完整分页渲染需要接入 pdf.js 或后端页级转码。`]
      } else {
        renderMode = 'unsupported'
        pages = [`${file.name}\n该格式需要后端转码服务后才能完整预览。`]
      }
    } catch (error) {
      console.error(error)
      renderMode = 'unsupported'
      pages = [`${file.name}\n本地解析失败。建议接入后端 LibreOffice/OnlyOffice 转码服务生成可预览页。`]
    }

    const next: LibraryDocument = {
      id: `upload-${Date.now()}`,
      title: file.name.replace(/\.[^.]+$/, ''),
      source: 'upload',
      kind,
      owner: '本地上传',
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      status: 'local',
      pages,
      previewUrl,
      renderMode,
    }
    setDocuments((prev) => [next, ...prev])
    selectDocument(next.id)
    message.success(renderMode === 'unsupported' ? '文件已添加，当前格式需要转码后完整预览' : '文件已解析并添加到文档中心')
  }

  return (
    <div className="atop-page-shell atop-doc-page">
      <PageHeader
        eyebrow="DOCUMENT LIBRARY"
        title="文档中心"
        subtitle="连接飞书或外部文档，也可以上传文件；阅读区按书本方式翻页，并只渲染当前页附近内容。"
        extra={
          <>
            <Button icon={<LinkOutlined />} onClick={() => setConnectOpen(true)}>连接文档</Button>
            <Button type="primary" icon={<UploadOutlined />} onClick={() => uploadInputRef.current?.click()}>上传文件</Button>
            <input
              ref={uploadInputRef}
              className="atop-doc-file-input"
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.md,.txt,.png,.jpg,.jpeg"
              onChange={(event) => handleUploadFile(event.target.files?.[0])}
            />
          </>
        }
      />

      <div className="atop-doc-shell">
        <aside className="atop-doc-library">
          <div className="atop-doc-library-tools">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索文档、来源、负责人"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Segmented
              block
              value={sourceFilter}
              onChange={(value) => setSourceFilter(value as DocumentSource | 'all')}
              options={[
                { label: '全部', value: 'all' },
                { label: '飞书', value: 'feishu' },
                { label: '上传', value: 'upload' },
                { label: '外链', value: 'link' },
              ]}
            />
          </div>
          <div className="atop-doc-list">
            {filteredDocuments.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`atop-doc-item atop-doc-kind-${item.kind}${item.id === selected?.id ? ' is-active' : ''}`}
                onClick={() => selectDocument(item.id)}
              >
                <span className="atop-doc-item-icon">{kindIcon(item.kind)}</span>
                <span className="atop-doc-item-main">
                  <strong>{item.title}</strong>
                  <small>{item.owner} · {item.updatedAt}</small>
                </span>
                <Tag color={sourceTagColor(item.source)}>{KIND_LABEL[item.kind]}</Tag>
              </button>
            ))}
            {filteredDocuments.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无匹配文档" />}
          </div>
        </aside>

        <main className="atop-doc-reader">
          {selected ? (
            <>
              <div className="atop-doc-reader-head">
                <div>
                  <Space size={8} wrap>
                    <Tag color={sourceTagColor(selected.source)}>{SOURCE_LABEL[selected.source]}</Tag>
                    <Tag>{KIND_LABEL[selected.kind]}</Tag>
                    <Tag>{selected.size}</Tag>
                    <Tag icon={<CloudSyncOutlined />}>{selected.status === 'local' ? '本地会话' : '可同步'}</Tag>
                  </Space>
                  <h2>{selected.title}</h2>
                  <p>当前仅渲染第 {pageIndex + 1}-{Math.min(pageIndex + 2, totalPages)} 页，翻页时预留相邻页缓存位。</p>
                </div>
                <div className="atop-doc-progress">
                  <Progress percent={progress} size="small" showInfo={false} />
                  <span>{pageIndex + 1} / {totalPages}</span>
                </div>
              </div>

              <div className={`atop-doc-book atop-doc-book-${selected.kind} ${turning ? `is-turning-${turning}` : ''}`}>
                <button
                  type="button"
                  className="atop-doc-book-page atop-doc-book-page-left"
                  disabled={pageIndex === 0 || Boolean(turning)}
                  onClick={() => turnPage('prev')}
                  aria-label="翻到上一页"
                >
                  <div className="atop-doc-page-number">{pageIndex + 1}</div>
                  <div className="atop-doc-page-kind">{kindIcon(selected.kind)}<span>{KIND_LABEL[selected.kind]}</span></div>
                  {renderDocumentPage(selected, leftPage, 'left')}
                </button>
                <button
                  type="button"
                  className="atop-doc-book-page atop-doc-book-page-right"
                  disabled={pageIndex >= totalPages - 2 || Boolean(turning)}
                  onClick={() => turnPage('next')}
                  aria-label="翻到下一页"
                >
                  <div className="atop-doc-page-number">{Math.min(pageIndex + 2, totalPages)}</div>
                  <div className="atop-doc-page-kind">{kindIcon(selected.kind)}<span>{KIND_LABEL[selected.kind]}</span></div>
                  {renderDocumentPage(selected, rightPage, 'right')}
                </button>
                {turning && (
                  <div className={`atop-doc-turn-sheet atop-doc-turn-${turning}`}>
                    <div>{turning === 'next' ? rightPage || leftPage : leftPage}</div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择文档" />
          )}
        </main>
      </div>

      <Modal
        title="连接文档"
        open={connectOpen}
        onCancel={() => setConnectOpen(false)}
        onOk={addLinkedDocument}
        okText="添加"
        cancelText="取消"
      >
        <div className="atop-doc-connect-form">
          <label>
            <span>来源</span>
            <Select
              value={connectType}
              onChange={setConnectType}
              options={[
                { label: '飞书文档', value: 'feishu' },
                { label: '外部链接', value: 'link' },
              ]}
            />
          </label>
          <label>
            <span>文档名称</span>
            <Input value={connectTitle} onChange={(event) => setConnectTitle(event.target.value)} placeholder="例如：发布验收手册" />
          </label>
          <label>
            <span>连接地址</span>
            <Input value={connectUrl} onChange={(event) => setConnectUrl(event.target.value)} placeholder="https://..." />
          </label>
        </div>
      </Modal>
    </div>
  )
}
