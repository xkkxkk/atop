import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, Empty, Input, Pagination, Segmented, Space, Tag, message } from 'antd'
import { useSearchParams } from 'react-router-dom'
import {
  ApiOutlined, BranchesOutlined, CheckCircleOutlined, CodeOutlined,
  CopyOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons'
import PageHeader from '@/components/common/PageHeader'
import { VERSION_HISTORY, type VersionHistoryChannel, type VersionHistoryEntry } from '@/data/versionHistory'

type ChannelFilter = 'all' | 'frontend' | 'backend'
const PAGE_SIZE = 10

function normalizeVersion(value: string) {
  const trimmed = value.trim().toLowerCase()
  return trimmed.replace(/^v/, '')
}

function findVersion(value: string) {
  const normalized = normalizeVersion(value)
  return VERSION_HISTORY.find((item) => normalizeVersion(item.version) === normalized)
}

function channelLabel(channel: VersionHistoryChannel['channel']) {
  return channel === 'frontend' ? '前端' : '后端'
}

function channelIcon(channel: VersionHistoryChannel['channel']) {
  return channel === 'frontend' ? <CodeOutlined /> : <ApiOutlined />
}

function collectSearchText(item: VersionHistoryEntry) {
  return [
    item.version,
    item.date,
    item.time,
    item.title,
    item.desc,
    item.frontend?.commit,
    item.backend?.commit,
    ...(item.frontend?.changes ?? []),
    ...(item.backend?.changes ?? []),
  ].join(' ').toLowerCase()
}

function VersionChannelPanel({ data }: { data?: VersionHistoryChannel }) {
  if (!data) {
    return (
      <div className="atop-version-detail-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该版本未记录此端更新" />
      </div>
    )
  }

  return (
    <div className={`atop-version-detail-channel atop-version-detail-${data.channel}`}>
      <div className="atop-version-detail-channel-head">
        <span>{channelIcon(data.channel)}</span>
        <div>
          <strong>{channelLabel(data.channel)}更新</strong>
          <small>{data.env}</small>
        </div>
        <Tag color={data.channel === 'frontend' ? 'blue' : 'green'}>{data.env}</Tag>
      </div>
      <div className="atop-version-detail-facts">
        <div>
          <span>版本号</span>
          <strong>{data.version}</strong>
        </div>
        <div>
          <span>构建时间</span>
          <strong>{data.buildTime}</strong>
        </div>
      </div>
      <div className="atop-version-detail-meta">
        <span>提交标识</span>
        <code>{data.commit}</code>
      </div>
      <div className="atop-version-detail-change-title">
        <span>更新内容</span>
        <Tag>{data.changes.length} 项</Tag>
      </div>
      <ul className="atop-version-detail-changes">
        {data.changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>
    </div>
  )
}

export default function VersionManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [keyword, setKeyword] = useState('')
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [selectedVersion, setSelectedVersion] = useState(VERSION_HISTORY[0]?.version ?? '')
  const [page, setPage] = useState(1)
  const skipInitialFilterResetRef = useRef(true)
  const latestVersion = VERSION_HISTORY[0]?.version ?? '-'

  const filteredVersions = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return VERSION_HISTORY.filter((item) => {
      if (channel === 'frontend' && !item.frontend) return false
      if (channel === 'backend' && !item.backend) return false
      return !query || collectSearchText(item).includes(query)
    })
  }, [channel, keyword])

  const selected = filteredVersions.find((item) => item.version === selectedVersion)
    ?? filteredVersions[0]
    ?? VERSION_HISTORY[0]
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredVersions.length / PAGE_SIZE)))
  const pagedVersions = filteredVersions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const frontendCount = VERSION_HISTORY.filter((item) => item.frontend).length
  const backendCount = VERSION_HISTORY.filter((item) => item.backend).length
  const oldestVersion = VERSION_HISTORY[VERSION_HISTORY.length - 1]?.version ?? '-'

  useEffect(() => {
    const targetVersion = searchParams.get('version')
    if (!targetVersion) return
    const target = findVersion(targetVersion)
    if (!target) return
    setKeyword('')
    setChannel('all')
    setSelectedVersion(target.version)
    const index = VERSION_HISTORY.findIndex((item) => item.version === target.version)
    setPage(Math.floor(index / PAGE_SIZE) + 1)
  }, [searchParams])

  useEffect(() => {
    if (skipInitialFilterResetRef.current) {
      skipInitialFilterResetRef.current = false
      return
    }
    setPage(1)
  }, [channel, keyword])

  useEffect(() => {
    const query = keyword.trim()
    if (!query) return
    const target = findVersion(query)
    if (!target) return
    setSelectedVersion(target.version)
    const index = filteredVersions.findIndex((item) => item.version === target.version)
    if (index >= 0) {
      setPage(Math.floor(index / PAGE_SIZE) + 1)
    }
  }, [filteredVersions, keyword])

  const selectVersion = (version: string) => {
    setSelectedVersion(version)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('version', version)
    setSearchParams(nextParams, { replace: true })
  }

  const copySelected = async () => {
    if (!selected) return
    const blocks = [selected.frontend, selected.backend]
      .filter(Boolean)
      .map((item) => {
        const data = item as VersionHistoryChannel
        return `${channelLabel(data.channel)} ${data.version}\ncommit=${data.commit}\nbuild=${data.buildTime}\n${data.changes.map((change) => `- ${change}`).join('\n')}`
      })
      .join('\n\n')
    const text = `${selected.version} ${selected.title}\n${blocks}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (!copied) throw new Error('copy command failed')
      }
      message.success(`已复制 ${selected.version} 版本说明`)
    } catch (error) {
      console.error(error)
      message.error('复制失败，请检查浏览器剪贴板权限')
    }
  }

  return (
    <div className="atop-page-shell atop-version-page">
      <PageHeader
        eyebrow="RELEASE CENTER"
        title="版本管理"
        subtitle="按时间查看每个版本的前端、后端发布信息和更新内容；弹窗只保留提醒，完整记录在这里维护。"
        extra={
          <>
            <Button icon={<CopyOutlined />} onClick={copySelected}>复制当前版本</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>刷新页面</Button>
          </>
        }
      />

      <div className="atop-version-page-summary">
        <div>
          <span>当前使用版本</span>
          <strong>{latestVersion}</strong>
          <small>{VERSION_HISTORY[0]?.title ?? '暂无记录'}</small>
        </div>
        <div>
          <span>前端记录</span>
          <strong>{frontendCount}</strong>
          <small>包含静态资源、页面和交互变更</small>
        </div>
        <div>
          <span>后端记录</span>
          <strong>{backendCount}</strong>
          <small>包含接口、权限和数据结构变更</small>
        </div>
        <div>
          <span>历史范围</span>
          <strong>{oldestVersion} - {latestVersion}</strong>
          <small>按发布时间倒序展示</small>
        </div>
      </div>

      <Card className="atop-panel-card atop-version-workbench" styles={{ body: { padding: 0 } }}>
        <div className="atop-version-workbench-sidebar">
          <div className="atop-version-workbench-tools">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索版本、提交、更新内容"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Segmented
              block
              value={channel}
              onChange={(value) => setChannel(value as ChannelFilter)}
              options={[
                { label: '全部', value: 'all' },
                { label: '前端', value: 'frontend' },
                { label: '后端', value: 'backend' },
              ]}
            />
          </div>
          <div className="atop-version-timeline-list">
            {pagedVersions.map((item) => {
              const active = item.version === selected.version
              const current = item.version === latestVersion
              return (
                <button
                  key={item.version}
                  type="button"
                  className={`atop-version-timeline-item${active ? ' is-active' : ''}${current ? ' is-current' : ''}`}
                  onClick={() => selectVersion(item.version)}
                >
                  <span className="atop-version-timeline-dot">
                    {active ? <CheckCircleOutlined /> : <BranchesOutlined />}
                  </span>
                  <span className="atop-version-timeline-main">
                    <span className="atop-version-timeline-title-row">
                      <strong>{item.version}</strong>
                      {current && <span className="atop-version-current-pill">当前使用</span>}
                    </span>
                    <small>{item.title}</small>
                  </span>
                  <span className="atop-version-timeline-date">{item.date}{item.time ? ` ${item.time}` : ''}</span>
                </button>
              )
            })}
            {filteredVersions.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无匹配版本" />}
          </div>
          {filteredVersions.length > PAGE_SIZE && (
            <div className="atop-version-pagination">
              <Pagination
                simple
                size="small"
                current={currentPage}
                pageSize={PAGE_SIZE}
                total={filteredVersions.length}
                onChange={setPage}
              />
            </div>
          )}
        </div>

        <div className="atop-version-detail">
          {selected ? (
            <>
              <div className="atop-version-detail-head">
                <div>
                  <Space size={8} wrap>
                    <Tag color="blue">{selected.version}</Tag>
                    {selected.version === latestVersion && <Tag color="green">当前使用</Tag>}
                    <Badge status="processing" text={`${selected.date}${selected.time ? ` ${selected.time}` : ''}`} />
                  </Space>
                  <h2>{selected.title}</h2>
                  <p>{selected.desc}</p>
                </div>
              </div>

              <div className="atop-version-detail-grid">
                <VersionChannelPanel data={selected.frontend} />
                <VersionChannelPanel data={selected.backend} />
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择版本" />
          )}
        </div>
      </Card>
    </div>
  )
}
