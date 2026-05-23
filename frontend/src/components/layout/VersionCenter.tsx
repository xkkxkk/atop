import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Drawer, Modal, Popover, Space, Tag, Timeline, message } from 'antd'
import {
  ApiOutlined, BranchesOutlined, CheckCircleOutlined, ClockCircleOutlined,
  CodeOutlined, CopyOutlined, HistoryOutlined, InfoCircleOutlined, ReloadOutlined, ArrowRightOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import { VERSION_HISTORY } from '@/data/versionHistory'

type VersionChannel = 'frontend' | 'backend'
type RemindMode = '10m' | '30m' | '2h' | 'never'

interface VersionItem {
  channel: VersionChannel
  label: string
  current: string
  latest: string
  buildTime: string
  commit: string
  note: string
  hasUpdate: boolean
  status?: string
  env?: string
  features?: string[]
  changes?: string[]
}

type VersionPayload = {
  version?: string
  latest?: string
  buildTime?: string
  commit?: string
  env?: string
  status?: string
  features?: string[]
  changes?: string[]
}

const FRONTEND_FALLBACK: VersionPayload = {
  version: 'v1.0.24',
  latest: 'v1.0.24',
  buildTime: '2026-05-22 07:55',
  commit: 'document-upload-local-preview-20260522',
  env: 'production',
  status: 'fallback',
  features: ['运行大盘', '运行记录', '全局命令搜索', '流水线运行前检查', '失败归因摘要', '顶部标签管理', '用户与角色管理', '保存筛选视图', '权限变更确认', '通知规则测试', '个人固定标签', '版本提示优化', '版本管理页', '版本管理左侧菜单', 'Jenkins 模板折叠', 'Agent 容量状态收敛', '版本管理页精修', '版本搜索定位与复制修复', '版本管理工作区间距修正', '文档中心仿真翻页', '文档类型样式与点击翻书', '文档上传本地真实预览'],
  changes: [
    '上传 docx 文件后从 word/document.xml 抽取文本并生成可翻页预览内容',
    '上传 pptx 文件后从 ppt/slides 提取每页文本并按幻灯片生成翻页内容',
    '上传 Markdown/TXT 文件后直接读取文本并分页展示',
    '上传图片后在书页中直接显示真实图片预览，避免只显示说明文字',
    'PDF、doc、ppt 等需要转码的格式会明确提示接入 pdf.js 或后端 LibreOffice/OnlyOffice 转码',
    '文档中心增加文档类型识别，PPT、Word、Markdown、PDF、图片和飞书文档都有独立图标与视觉样式',
    '书本阅读区按文档类型渲染不同页面质感，PPT 更接近演示页，Word/PDF/Markdown 保留各自阅读特征',
    '移除上一页/下一页按钮，改为点击左页返回、点击右页前进',
    '翻页动效升级为 3D 覆盖页旋转，模拟真实翻书过程',
    '上传文件支持 ppt/pptx 类型，并按扩展名推断文档样式',
    '新增 /documents 文档中心页面，左侧导航和全局搜索均可进入',
    '文档中心支持添加飞书文档连接、外部链接和本地上传文件到当前文档列表',
    '阅读区采用书本式双页布局，点击上一页/下一页时展示仿真翻页动效',
    '文档预览按当前页和相邻页设计渲染，避免一次性加载整本文档造成性能压力',
    '窄屏下文档中心自动切换为单列布局，避免书页和列表横向溢出',
    '版本管理页容器显式改为纵向 flex，使工作区高度和底部 10px 收口规则稳定生效',
    '版本管理工作区增加 10px margin-top，修复概览卡片与搜索区之间缺少外部间距的问题',
    '版本管理工作区高度调高并撑满页面剩余空间，最终仍按页面底部 10px 收口',
    '左侧版本列表保持每页 10 条，列表区域随工作区高度展开，确保 10 条正常展示',
    '补齐顶部概览与工作区之间的视觉间距，避免搜索区贴住上方卡片',
    '版本搜索和 URL 参数支持 1.0.2、v1.0.2、V1.0.2 等写法，并自动切换到对应分页和版本',
    '复制当前版本增加剪贴板降级方案和成功/失败提示，避免按钮点击无反馈',
    '通知规则页移除外部 Webhook 规则统计说明，页面只保留规则概览和列表内容',
    '版本管理左侧列表调整为每页 10 条，并在列表区域内滚动，避免页面被历史版本撑高',
    '版本管理左侧列表直接标识当前使用版本，详情区继续同步显示当前使用标签',
    '版本详情的前端更新和后端更新卡片重排版本号、构建时间、提交标识和更新内容，提升可读性',
    '版本管理页顶部概览、工作区间距和底部留白收紧，页面底部按 10px 目标收口',
    '新增 Ctrl/⌘ + K 全局命令搜索，可搜索页面、流水线、运行记录、用户和通知规则',
    '流水线触发前增加本地预检，阻断必填参数缺失、Jenkins 异常、Job 漏配和画布起始节点问题',
    '运行详情新增失败归因摘要，聚合失败组件、Jenkins 回执和处理建议',
    '运行大盘需要关注事项支持认领、处理完成、忽略、备注和跳转处理',
    '顶部标签新增固定、关闭其他、关闭左侧、关闭右侧和关闭全部未固定',
    '用户管理和角色管理列表新增右键快捷菜单',
    '运行记录、流水线、审计日志新增个人筛选视图保存与常用预设',
    '角色权限保存前新增本次变更 diff 确认，避免误改权限',
    '通知规则新增测试发送入口，并复用通知规则编辑权限控制',
    '筛选视图改为后端按用户保存，刷新和换设备后仍保留',
    '运行大盘作为默认固定标签常驻，顶部标签支持右键菜单，固定标签按用户偏好保存',
    '版本弹窗按前端和后端分区展示更新内容，提醒按钮点击后立即关闭弹窗',
    '版本弹窗样式收紧，避免更新内容卡片拥挤和状态标签错位',
    '通知规则测试发送改为按规则接收人配置投递，支持全体成员、项目负责人和自定义邮箱',
    '修复顶部固定标签偏好接口循环请求，接口不可用提示增加去重降噪',
    '固定标签偏好读取增加同用户同权限签名硬闸门，防止重复渲染触发请求风暴',
    '通知规则测试结果只统计实际勾选且发送成功的渠道，避免未勾选邮件时展示邮箱数量',
    '全局命令搜索每次打开自动清空输入',
    '消息铃铛去掉冗余关闭按钮，只保留查看全部消息入口',
    '保存筛选视图改为用户级视图面板，常用预设和我的视图分区并展示当前选中态',
    '筛选条件已命中预设或已保存视图时，保存当前进入已保存状态，避免重复保存',
    '运行大盘的全屏按钮改为当前页面直接进入浏览器全屏，不再跳转独立全屏页',
    '统一页面底部 10px 间距，Jenkins 实例等页面底部不再贴边',
    '版本弹窗等待前端静态版本和后端版本接口都完成检测后再一次性汇总展示',
    '版本弹窗改为单一滚动区和版本摘要布局，避免前后端内容分段闪现和卡片内部滚动条',
    '原全屏大盘中的高频流水线质量、质量风险 Top 5、Agent 容量状态已并入运行大盘',
    '新增独立版本管理页，可按前端/后端筛选、搜索版本记录并复制当前版本说明',
    '版本中心抽屉增加跳转完整版本历史入口，避免弹窗承载过长历史内容',
    '修复版本管理页 Array.at 兼容性问题，保证现有 TypeScript 目标库可构建',
    '左侧导航新增版本管理入口，进入 /versions 时菜单和顶部标签可正常高亮',
    '版本管理页显示当前使用版本，当前版本在详情区增加标识',
    '版本列表改为分页展示，避免左侧长列表撑高页面和产生多余底部空白',
    '页面工作区按内容高度展示，底部只保留 10px 间距',
    '全局命令搜索支持检索版本历史，搜索 v1.0.13 等版本号后可直接跳转并选中对应版本',
    'Jenkins 实例页的 Jenkins 接入模板默认收起，点击展开后再查看 Shared Library 和 Jenkinsfile 示例',
    '运行大盘 Agent 容量状态只展示当前卡片可承载的 3 个节点，避免节点过多撑高页面',
    'Agent 容量状态超出 3 个节点时显示查看更多入口，并跳转到 Jenkins 实例的 Agent 资源视图',
    'Jenkins 实例页支持 /settings/jenkins?view=agents 直接打开 Agent 节点资源视图',
  ],
}

const BACKEND_FALLBACK: VersionPayload = {
  version: '未连接',
  latest: '未连接',
  buildTime: '后端接口未返回',
  commit: 'pending-api',
  env: 'unknown',
  status: 'unknown',
  features: ['等待 /api/version'],
  changes: ['等待后端 /api/version 返回更新内容'],
}

const REMIND_MINUTES: Record<Exclude<RemindMode, 'never'>, number> = {
  '10m': 10,
  '30m': 30,
  '2h': 120,
}

const STORAGE_SNOOZE = 'atop-version-update-snooze-until'
const STORAGE_SKIP = 'atop-version-update-skip-key'

function normalizeVersion(version?: string) {
  return (version ?? '').trim().replace(/^v/i, '')
}

function canCompareVersion(version?: string) {
  return Boolean(version && version !== '-' && version !== '未连接')
}

function getSnoozeUntil(updateKey: string) {
  try {
    const raw = localStorage.getItem(STORAGE_SNOOZE)
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { key?: string; until?: number }
    if (parsed?.key === updateKey) return Number(parsed.until ?? 0)
  } catch {
    return 0
  }
  return 0
}

function saveSnooze(updateKey: string, until: number) {
  try {
    localStorage.setItem(STORAGE_SNOOZE, JSON.stringify({ key: updateKey, until }))
  } catch {
    // 当前会话内的 dismissedUpdateKey 仍会阻止弹窗立刻重开。
  }
}

async function fetchFrontendVersion() {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error('version.json missing')
  return await res.json() as VersionPayload
}

async function fetchBackendVersion() {
  return client.get('/version').then((r) => r.data.data ?? r.data) as Promise<VersionPayload>
}

function makeVersionItem(channel: VersionChannel, label: string, payload: VersionPayload, fallback: VersionPayload, loadedVersion?: string): VersionItem {
  const latest = payload.latest || payload.version || fallback.latest || fallback.version || '-'
  const current = loadedVersion || payload.version || fallback.version || '-'
  const hasUpdate = canCompareVersion(current)
    && canCompareVersion(latest)
    && normalizeVersion(latest) !== normalizeVersion(current)
  return {
    channel,
    label,
    current,
    latest,
    buildTime: payload.buildTime || fallback.buildTime || '-',
    commit: payload.commit || fallback.commit || '-',
    env: payload.env || fallback.env,
    status: payload.status || fallback.status,
    features: payload.features || fallback.features || [],
    changes: payload.changes || fallback.changes || [],
    note: channel === 'frontend'
      ? '来自前端静态 version.json，可随前端部署包一起更新'
      : '来自后端 /api/version，用于确认接口服务与前端资源是否匹配',
    hasUpdate,
  }
}

export default function VersionCenter() {
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState('')
  const [backendCurrentVersion, setBackendCurrentVersion] = useState<string | undefined>(undefined)
  const [frontendChecked, setFrontendChecked] = useState(false)
  const [backendChecked, setBackendChecked] = useState(false)

  const { data: frontendVersion, mutate: reloadFrontend } = useSWR('frontend-version', fetchFrontendVersion, {
    fallbackData: FRONTEND_FALLBACK,
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    onSuccess: () => setFrontendChecked(true),
    onError: () => setFrontendChecked(true),
  })
  const { data: backendVersion, mutate: reloadBackend } = useSWR('backend-version', fetchBackendVersion, {
    fallbackData: BACKEND_FALLBACK,
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    onSuccess: () => setBackendChecked(true),
    onError: () => setBackendChecked(true),
  })

  useEffect(() => {
    const backendLatest = backendVersion?.version || backendVersion?.latest
    if (!backendCurrentVersion && canCompareVersion(backendLatest)) {
      setBackendCurrentVersion(backendLatest)
    }
  }, [backendCurrentVersion, backendVersion?.latest, backendVersion?.version])

  const versionItems = useMemo(() => [
    makeVersionItem('frontend', '前端', frontendVersion ?? FRONTEND_FALLBACK, FRONTEND_FALLBACK, FRONTEND_FALLBACK.version),
    makeVersionItem('backend', '后端', backendVersion ?? BACKEND_FALLBACK, BACKEND_FALLBACK, backendCurrentVersion),
  ], [backendCurrentVersion, backendVersion, frontendVersion])
  const versionCheckReady = frontendChecked && backendChecked
  const hasUpdate = versionItems.some((item) => item.hasUpdate)
  const updatedItems = versionItems.filter((item) => item.hasUpdate)
  const updateKey = versionItems.map((item) => `${item.channel}:${item.latest}`).join('|')

  useEffect(() => {
    if (!versionCheckReady) return
    if (!hasUpdate) {
      setModalOpen(false)
      return
    }
    if (dismissedUpdateKey === updateKey) return
    let skipped = ''
    try {
      skipped = localStorage.getItem(STORAGE_SKIP) ?? ''
    } catch {
      skipped = ''
    }
    if (skipped === updateKey) return
    const snoozeUntil = getSnoozeUntil(updateKey)
    if (snoozeUntil > Date.now()) return
    setModalOpen(true)
  }, [dismissedUpdateKey, hasUpdate, updateKey, versionCheckReady])

  const currentText = useMemo(() => {
    const frontend = versionItems.find((item) => item.channel === 'frontend')?.current ?? '-'
    const backend = versionItems.find((item) => item.channel === 'backend')?.current ?? '-'
    return `FE ${frontend} / BE ${backend}`
  }, [versionItems])

  const refreshVersions = () => {
    setFrontendChecked(false)
    setBackendChecked(false)
    reloadFrontend()
    reloadBackend()
  }

  const handleRefresh = () => {
    window.location.reload()
  }

  const copyVersionInfo = async () => {
    const text = versionItems
      .map((item) => `${item.label}: ${item.current} | build=${item.buildTime} | commit=${item.commit} | env=${item.env ?? '-'}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      message.success('版本信息已复制')
    } catch {
      message.warning('当前浏览器不支持复制')
    }
  }

  const closeUpdateModal = () => {
    setDismissedUpdateKey(updateKey)
    setModalOpen(false)
  }

  const applyReminder = (mode: RemindMode) => {
    setDismissedUpdateKey(updateKey)
    if (mode === 'never') {
      try {
        localStorage.setItem(STORAGE_SKIP, updateKey)
      } catch {
        // 当前会话内已关闭；下次检测再按实际版本状态处理。
      }
    } else {
      saveSnooze(updateKey, Date.now() + REMIND_MINUTES[mode] * 60 * 1000)
    }
    setModalOpen(false)
  }

  const handleDelay = () => {
    applyReminder('10m')
  }

  const openVersionPage = () => {
    setDrawerOpen(false)
    navigate('/versions')
  }

  const popoverContent = (
    <div className="atop-version-popover">
      <div className="atop-version-popover-head">
        <strong>版本中心</strong>
        <Tag color={hasUpdate ? 'warning' : 'success'}>{hasUpdate ? '有更新' : '已是最新'}</Tag>
      </div>
      {versionItems.map((item) => (
        <div key={item.channel} className="atop-version-mini-row">
          <span className="atop-version-mini-icon">
            {item.channel === 'frontend' ? <CodeOutlined /> : <ApiOutlined />}
          </span>
          <div>
            <div className="atop-version-mini-title">{item.label} · {item.current}</div>
            <div className="atop-version-mini-desc">{item.buildTime}</div>
          </div>
        </div>
      ))}
      <Button size="small" type="primary" ghost block icon={<HistoryOutlined />} onClick={openVersionPage}>
        打开版本管理
      </Button>
    </div>
  )

  return (
    <>
      <Popover content={popoverContent} trigger="hover" placement="bottomRight">
        <Button
          className="atop-version-trigger"
          type="text"
          aria-label="查看版本信息"
          onClick={() => setDrawerOpen(true)}
        >
          <Badge dot={versionCheckReady && hasUpdate} offset={[-2, 2]}>
            <BranchesOutlined />
          </Badge>
        </Button>
      </Popover>

      <Modal
        open={modalOpen}
        title="检测到平台新版本"
        className="atop-version-modal"
        onCancel={closeUpdateModal}
        footer={
          <Space>
            <Button onClick={handleDelay}>稍后提醒</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={handleRefresh}>立即刷新</Button>
          </Space>
        }
        width={840}
      >
        <div className="atop-version-update">
          <div className="atop-version-update-icon"><InfoCircleOutlined /></div>
          <div>
            <div className="atop-version-update-title">检测到可更新版本，刷新后将切换到最新资源。</div>
            <div className="atop-version-update-desc">
              已完成前端静态资源和后端版本接口检测，本次结果一次性汇总如下。
              如果正在编辑内容，可以先选择稍后提醒，避免当前操作被刷新中断。
            </div>
          </div>
        </div>
        <div className="atop-version-update-summary">
          {updatedItems.map((item) => (
            <div key={item.channel} className="atop-version-update-summary-row">
              <span className={`atop-version-update-summary-icon atop-version-update-summary-icon-${item.channel}`}>
                {item.channel === 'frontend' ? <CodeOutlined /> : <ApiOutlined />}
              </span>
              <strong>{item.label}</strong>
              <span>当前 {item.current}</span>
              <span>最新 {item.latest}</span>
            </div>
          ))}
        </div>
        <div className="atop-version-update-sections">
          {updatedItems.map((item) => (
            <div key={item.channel} className={`atop-version-update-section atop-version-update-section-${item.channel}`}>
              <div className="atop-version-update-section-head">
                <span>{item.channel === 'frontend' ? <CodeOutlined /> : <ApiOutlined />}</span>
                <strong>{item.label}更新内容</strong>
                <Tag color="warning">{item.current} → {item.latest}</Tag>
              </div>
              <ul>
                {(item.changes?.length ? item.changes : ['本次版本未填写更新说明，请检查版本配置。']).map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="atop-version-remind-buttons">
          <Button onClick={() => applyReminder('10m')}>10 分钟后</Button>
          <Button onClick={() => applyReminder('30m')}>30 分钟后</Button>
          <Button onClick={() => applyReminder('2h')}>2 小时后</Button>
          <Button onClick={() => applyReminder('never')}>本版本不再提示</Button>
        </div>
      </Modal>

      <Drawer
        title="版本管理"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={560}
        extra={
          <Space>
            <Button icon={<CopyOutlined />} onClick={copyVersionInfo}>复制信息</Button>
            <Button icon={<ReloadOutlined />} onClick={refreshVersions}>重新检测</Button>
            <Button type="primary" icon={<ArrowRightOutlined />} onClick={openVersionPage}>详细版本</Button>
          </Space>
        }
      >
        <div className="atop-version-current">{currentText}</div>
        <div className="atop-version-grid">
          {versionItems.map((item) => (
            <div key={item.channel} className="atop-version-card">
              <div className="atop-version-card-head">
                <span>{item.channel === 'frontend' ? <CodeOutlined /> : <ApiOutlined />}</span>
                <strong>{item.label}版本</strong>
                <Tag color={item.status === 'unknown' ? 'default' : item.hasUpdate ? 'warning' : 'success'}>
                  {item.status === 'unknown' ? '未连接' : item.hasUpdate ? '待更新' : '正常'}
                </Tag>
              </div>
              <div className="atop-version-number">{item.current}</div>
              <div className="atop-version-meta-grid">
                <span>最新版本：{item.latest}</span>
                <span>构建时间：{item.buildTime}</span>
                <span>提交标识：{item.commit}</span>
                <span>运行环境：{item.env ?? '-'}</span>
              </div>
              <div className="atop-version-feature-list">
                {(item.features ?? []).map((feature) => <Tag key={feature}>{feature}</Tag>)}
              </div>
              <div className="atop-version-note">{item.note}</div>
            </div>
          ))}
        </div>

        <div className="atop-version-history-title">
          <ClockCircleOutlined /> 最近版本
        </div>
        <Timeline
          items={VERSION_HISTORY.slice(0, 5).map((item, index) => ({
            color: index === 0 ? 'blue' : 'gray',
            dot: index === 0 ? <CheckCircleOutlined /> : undefined,
            children: (
              <div>
                <div className="atop-version-history-row">
                  <strong>{item.version}</strong>
                  <span>{item.time}</span>
                </div>
                <div className="atop-version-history-main">{item.title}</div>
                <div className="atop-version-history-desc">{item.desc}</div>
              </div>
            ),
          }))}
        />
        <Button block icon={<ArrowRightOutlined />} onClick={openVersionPage}>
          查看完整版本历史
        </Button>
      </Drawer>
    </>
  )
}
