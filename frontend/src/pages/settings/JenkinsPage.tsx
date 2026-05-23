import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useSearchParams } from 'react-router-dom'
import {
  Alert, Badge, Button, Card, Dropdown, Form, Input, Modal, Radio,
  Space, Table, Tabs, Tag, Transfer, message,
} from 'antd'
import {
  ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, ClusterOutlined,
  CodeOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, EyeOutlined, LinkOutlined,
  MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, SyncOutlined,
} from '@ant-design/icons'
import { jenkinsApi } from '@/api/settings'
import EmptyState from '@/components/common/EmptyState'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import { showConfirm } from '@/components/common/ConfirmModal'
import { useModalForm } from '@/hooks/useModalForm'
import { PermGuard, usePermission } from '@/hooks/usePermission'
import type { AgentLabel, AgentNode, JenkinsInstance } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

type FormValues = {
  name?: string
  url?: string
  username?: string
  apiToken?: string
  viewerToken?: string
  isDefault?: boolean
  agentSyncMode?: 'all' | 'fixed'
  fixedNodes?: string[]
}

type NodeModalState = {
  open: boolean
  title: string
  note: string
  loading?: boolean
  nodes: AgentNode[]
  labels?: AgentLabel[]
  defaultTab?: 'labels' | 'nodes'
}

const INSTANCE_KEY = 'jenkins-list'
const LABEL_KEY = 'agent-labels-all'
const NODE_KEY = 'agent-nodes-all'

const EMPTY_LABELS: AgentLabel[] = []

const ATOP_SHARED_LIBRARY_CODE = [
  'import groovy.json.JsonOutput',
  'import groovy.json.JsonSlurperClassic',
  'import javax.crypto.Mac',
  'import javax.crypto.spec.SecretKeySpec',
  '',
  'def payload() {',
  "  if (!params.ATOP_PAYLOAD?.trim()) {",
  "    error 'ATOP_PAYLOAD 为空，请通过 ATOP 平台触发 Jenkins Job'",
  '  }',
  '  return new JsonSlurperClassic().parseText(params.ATOP_PAYLOAD)',
  '}',
  '',
  'def webhookUrl() {',
  '  def data = payload()',
  "  return data.platform_webhook_url ?: data.webhookUrl ?: ''",
  '}',
  '',
  'def running(Map args = [:]) {',
  "  callback([status: 'running', phase: args.phase ?: 'running', node_name: args.nodeName ?: env.NODE_NAME ?: ''])",
  '}',
  '',
  'def success(Map outputs = [:]) {',
  "  callback([status: 'success', outputs: outputs])",
  '}',
  '',
  "def failure(String message = '') {",
  "  callback([status: 'failed', error_summary: message])",
  '}',
  '',
  "def abort(String reason = '') {",
  "  callback([status: 'aborted', abort_reason: reason, error_summary: reason])",
  '}',
  '',
  'def buildJob(Map args = [:]) {',
  '  def targetJob = args.job',
  '  if (!targetJob?.trim()) { error "job 不能为空" }',
  '  def waitForResult = args.containsKey("wait") ? args.wait : true',
  '  def propagateResult = args.containsKey("propagate") ? args.propagate : false',
  '  def jobParams = (args.parameters ?: [:]).collect { k, v ->',
  "    string(name: k.toString(), value: v == null ? '' : v.toString())",
  '  }',
  '  return build job: targetJob, parameters: jobParams, wait: waitForResult, propagate: propagateResult',
  '}',
  '',
  'def callback(Map body = [:]) {',
  '  def data = payload()',
  "  def url = data.platform_webhook_url ?: data.webhookUrl",
  "  if (!url?.trim()) { error 'ATOP 回调地址为空' }",
  "  body.task_id = body.task_id ?: data.task_id ?: env.ATOP_TASK_ID ?: ''",
  '  body.jenkins_build_id = currentBuild.number',
  "  body.jenkins_build_url = env.BUILD_URL ?: ''",
  "  body.duration_ms = body.duration_ms ?: 0",
  "  body.pass_rate = body.status == 'success' ? 100.0 : 0.0",
  '  def json = JsonOutput.toJson(body)',
  "  writeFile file: '.atop-callback.json', text: json",
  "  def headers = \"-H 'Content-Type: application/json'\"",
  "  def secret = env.ATOP_WEBHOOK_SECRET ?: ''",
  '  if (secret.trim()) {',
  "    headers += \" -H 'X-Atop-Signature: ${hmacSha256(secret, json)}'\"",
  '  }',
  "  sh \"curl -sS -X POST '${url}' ${headers} --data-binary @.atop-callback.json --max-time 15 --retry 2\"",
  '}',
  '',
  'String hmacSha256(String secret, String body) {',
  "  Mac mac = Mac.getInstance('HmacSHA256')",
  "  mac.init(new SecretKeySpec(secret.getBytes('UTF-8'), 'HmacSHA256'))",
  "  return mac.doFinal(body.getBytes('UTF-8')).encodeHex().toString()",
  '}',
].join('\n')

const ATOP_JENKINSFILE_EXAMPLE = [
  'pipeline {',
  '  agent any',
  '  parameters {',
  "    text(name: 'ATOP_PAYLOAD', defaultValue: '', description: 'ATOP 平台自动注入')",
  '  }',
  '  stages {',
  "    stage('Build') {",
  '      steps {',
  '        script {',
  "          atop.running(phase: 'build', nodeName: env.NODE_NAME)",
  "          def tag = sh(script: 'git describe --tags --always', returnStdout: true).trim()",
  "          def moduleName = 'api'",
  "          sh \"./build.sh --tag ${tag} --module ${moduleName}\"",
  "          atop.success([tag: tag, module: moduleName])",
  '        }',
  '      }',
  '    }',
  '  }',
  '  post {',
  "    failure { script { atop.failure(currentBuild.currentResult ?: 'failed') } }",
  "    aborted { script { atop.abort('aborted by Jenkins') } }",
  '  }',
  '}',
].join('\n')

const ATOP_JENKINS_WAIT_EXAMPLE = [
  "def tag = sh(script: 'git describe --tags --always', returnStdout: true).trim()",
  '',
  '// 只启动，不等待结果，类似 Jenkins wait: false',
"atop.buildJob(job: 'deploy-shadow', parameters: [TAG: tag], wait: false)",
  '',
  '// 等待结果，但不自动抛错，平台或脚本自己决定是否失败',
"def verify = atop.buildJob(job: 'verify-api', parameters: [TAG: tag], wait: true, propagate: false)",
  "if (verify.result != 'SUCCESS') {",
  "  error \"verify-api failed: ${verify.result}\"",
  '}',
  '',
  'atop.success([tag: tag, verifyResult: verify.result])',
].join('\n')

const ATOP_MAPPING_EXAMPLE = [
  '上游 Jenkins 组件 ID：build',
  '下游 Jenkins 组件参数映射：',
  '  TAG    = ${nodes.build.outputs.tag}',
  '  MODULE = ${nodes.build.outputs.module}',
  '  BRANCH = ${nodes.build.inputs.BRANCH}',
  '',
  '等待完成：下游会等待上游成功并拿到 outputs/inputs，且下游结果参与主流程。',
  '异步启动：下游同样会等待上游成功并拿到 outputs/inputs，再作为 Jenkins 参数启动；区别是下游结果不参与主流程完成状态。',
].join('\n')

function statusTag(status?: string) {
  if (status === 'ok') {
    return <Tag color="success" icon={<CheckCircleOutlined />}>可达</Tag>
  }
  if (status === 'unreachable') {
    return <Tag color="error" icon={<CloseCircleOutlined />}>不可达</Tag>
  }
  return <Tag>未检测</Tag>
}

function syncModeTag(mode?: string) {
  if (mode === 'fixed') {
    return <Tag color="purple">固定机器清单</Tag>
  }
  return <Tag color="blue">同步全部节点</Tag>
}

function matchesKeyword(text: string, keyword: string) {
  return text.toLowerCase().includes(keyword.trim().toLowerCase())
}

export default function JenkinsPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<JenkinsInstance | null>(null)
  const [saving, setSaving] = useState(false)
  const [checkingIds, setCheckingIds] = useState<Record<string, boolean>>({})
  const [syncingIds, setSyncingIds] = useState<Record<string, boolean>>({})
  const [templateOpen, setTemplateOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const defaultAgentView = searchParams.get('view') === 'agents' ? 'nodes' : undefined
  const [nodeModal, setNodeModal] = useState<NodeModalState>({
    open: false,
    title: '',
    note: '',
    nodes: [],
    labels: [],
    defaultTab: 'nodes',
  })
  const [modalKeyword, setModalKeyword] = useState('')
  const [form] = Form.useForm<FormValues>()
  const watchedFixedNodes = Form.useWatch('fixedNodes', form) ?? []
  const { cancelWithConfirm, markClean } = useModalForm(form)
  const { can } = usePermission()

  const { data: instances = [], isLoading: loadingInstances, mutate: mutateInstances } = useSWR(
    INSTANCE_KEY,
    jenkinsApi.list,
    { revalidateOnFocus: false }
  )
  const { data: labels = [], isLoading: loadingLabels, mutate: mutateLabels } = useSWR(
    LABEL_KEY,
    () => jenkinsApi.listLabels(),
    { revalidateOnFocus: false }
  )
  const { data: nodes = [], isLoading: loadingNodes, mutate: mutateNodes } = useSWR(
    NODE_KEY,
    () => jenkinsApi.listAgentNodes(),
    { revalidateOnFocus: false }
  )

  const instanceNameMap = useMemo(() => {
    const map: Record<string, string> = {}
    instances.forEach((item) => { map[item.id] = item.name })
    return map
  }, [instances])

  const getInstanceStats = (instanceId: string) => {
    const instanceNodes = nodes.filter((item) => item.jenkinsInstanceId === instanceId)
    const instanceLabels = labels.filter((item) => item.jenkinsInstanceId === instanceId)
    const syncTimes = [...instanceNodes.map((item) => item.lastSyncAt), ...instanceLabels.map((item) => item.lastSyncAt)]
      .filter(Boolean)
      .sort()
    return {
      labelCount: instanceLabels.length,
      nodeCount: instanceNodes.length,
      onlineNodeCount: instanceNodes.filter((item) => item.online).length,
      lastSync: syncTimes.length ? syncTimes[syncTimes.length - 1] : undefined,
    }
  }

  const modalNodes = useMemo(() => {
    if (!modalKeyword.trim()) return nodeModal.nodes
    return nodeModal.nodes.filter((item) => {
      const instanceName = instanceNameMap[item.jenkinsInstanceId] || ''
      return matchesKeyword(`${item.name} ${item.nodeId} ${item.os ?? ''} ${instanceName} ${(item.labels ?? []).join(' ')}`, modalKeyword)
    })
  }, [nodeModal.nodes, modalKeyword, instanceNameMap])

  const modalLabels = useMemo(() => {
    const modalLabelItems = nodeModal.labels ?? EMPTY_LABELS
    if (!modalKeyword.trim()) return modalLabelItems
    return modalLabelItems.filter((item) => {
      const instanceName = item.jenkinsInstanceName || instanceNameMap[item.jenkinsInstanceId] || ''
      return matchesKeyword(`${item.label} ${instanceName}`, modalKeyword)
    })
  }, [nodeModal.labels, modalKeyword, instanceNameMap])

  const fixedNodeOptions = useMemo(() => {
    const seen = new Set<string>()
    const syncedOptions = nodes.map((item) => {
      const nodeName = item.name || item.nodeId
      const instanceName = instanceNameMap[item.jenkinsInstanceId] || '未知实例'
      const labelsText = (item.labels ?? []).join(' ')
      seen.add(nodeName)
      return {
        key: nodeName,
        title: nodeName,
        description: `${instanceName} ${item.online ? '在线' : '离线'} ${item.os ?? ''} ${labelsText}`,
        node: item,
      }
    })
    const manualOptions = watchedFixedNodes
      .filter((name) => name && !seen.has(name))
      .map((name) => ({
        key: name,
        title: name,
        description: '未在当前同步结果中找到，保存后仍作为固定节点保留',
        node: {
          id: name,
          nodeId: name,
          name,
          labelId: '',
          jenkinsInstanceId: '',
          online: false,
          labels: [],
          lastSyncAt: '',
        } as AgentNode,
      }))
    return [...syncedOptions, ...manualOptions]
  }, [nodes, instanceNameMap, watchedFixedNodes])

  const reachableCount = instances.filter((item) => item.status === 'ok').length
  const onlineNodeCount = nodes.filter((item) => item.online).length
  const syncTimes = [...nodes.map((item) => item.lastSyncAt), ...labels.map((item) => item.lastSyncAt)]
    .filter(Boolean)
    .sort()
  const latestSyncAt = syncTimes.length ? syncTimes[syncTimes.length - 1] : undefined

  const refreshResources = () => {
    mutateInstances()
    mutateLabels()
    mutateNodes()
  }

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(`已复制${label}`)
    } catch {
      message.error('复制失败，请手动选择代码')
    }
  }

  const openCreate = () => {
    const initial: FormValues = {
      isDefault: instances.length === 0,
      agentSyncMode: 'all',
      fixedNodes: [],
    }
    setEditing(null)
    form.resetFields()
    form.setFieldsValue(initial)
    markClean(initial)
    setModalOpen(true)
  }

  const openEdit = (record: JenkinsInstance) => {
    const initial: FormValues = {
      name: record.name,
      url: record.url,
      username: record.username,
      apiToken: '',
      viewerToken: '',
      isDefault: record.isDefault,
      agentSyncMode: record.agentSyncMode === 'fixed' ? 'fixed' : 'all',
      fixedNodes: record.fixedNodes ?? [],
    }
    setEditing(record)
    form.setFieldsValue(initial)
    markClean(initial)
    setModalOpen(true)
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const payload: Partial<JenkinsInstance> & { apiToken?: string; viewerToken?: string } = {
        ...values,
        url: values.url?.replace(/\/+$/, ''),
        agentSyncMode: values.agentSyncMode === 'fixed' ? 'fixed' : 'all',
        fixedNodes: values.fixedNodes ?? [],
      }
      if (editing) {
        await jenkinsApi.update(editing.id, payload)
        message.success('Jenkins 实例已更新')
      } else {
        await jenkinsApi.create(payload)
        message.success('Jenkins 实例已创建')
      }
      setModalOpen(false)
      form.resetFields()
      refreshResources()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (record: JenkinsInstance) => {
    showConfirm({
      title: `确认删除 Jenkins 实例「${record.name}」？`,
      content: '删除前请确认没有流水线继续绑定该实例；平台会在后端再次检查引用关系。',
      okText: '删除',
      onOk: async () => {
        try {
          await jenkinsApi.delete(record.id)
          message.success('已删除')
          refreshResources()
        } catch (e: any) {
          message.error(e?.response?.data?.message || '删除失败')
          throw e
        }
      },
    })
  }

  const handlePing = async (record: JenkinsInstance) => {
    setCheckingIds((prev) => ({ ...prev, [record.id]: true }))
    try {
      const res = await jenkinsApi.ping(record.id)
      if (res.status === 'ok') {
        message.success(`连接正常${res.latencyMs ? `，${res.latencyMs}ms` : ''}`)
      } else {
        message.warning('Jenkins 当前不可达')
      }
      mutateInstances()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '检测失败')
    } finally {
      setCheckingIds((prev) => ({ ...prev, [record.id]: false }))
    }
  }

  const handleSync = async (record: JenkinsInstance) => {
    setSyncingIds((prev) => ({ ...prev, [record.id]: true }))
    try {
      const res = await jenkinsApi.syncAgents(record.id)
      message.success(`已读取 ${res.totalNodes ?? 0} 个节点，生成 ${res.synced ?? 0} 个标签能力`)
      mutateLabels()
      mutateNodes()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '同步失败')
    } finally {
      setSyncingIds((prev) => ({ ...prev, [record.id]: false }))
    }
  }

  const openInstanceNodes = (record: JenkinsInstance) => {
    const instanceNodes = nodes.filter((item) => item.jenkinsInstanceId === record.id)
    const instanceLabels = labels.filter((item) => item.jenkinsInstanceId === record.id)
    setModalKeyword('')
    setNodeModal({
      open: true,
      title: `${record.name} · 资源详情`,
      note: '这里分页查看该实例同步到的平台资源。节点池来自 Jenkins Computer API；运行节点由 Jenkins Pipeline / Jenkinsfile 自行调度。',
      nodes: instanceNodes,
      labels: instanceLabels,
      defaultTab: 'nodes',
    })
  }

  const openAllResources = (defaultTab: 'labels' | 'nodes') => {
    setModalKeyword('')
    setNodeModal({
      open: true,
      title: '全部 Jenkins Agent 资源',
      note: '按需分页查看所有实例同步到的平台资源。主页面保留概览，避免节点规模变大后列表挤占页面空间。',
      nodes,
      labels,
      defaultTab,
    })
  }

  const renderNodeName = (record: AgentNode) => (
    <div className="atop-instance-cell">
      <Badge status={record.online ? 'success' : 'default'} />
      <div className="atop-jenkins-node-copy">
        <strong>{record.name || record.nodeId}</strong>
        <span>{record.nodeId}</span>
      </div>
    </div>
  )

  const nodeColumns = [
    {
      title: '节点',
      key: 'node',
      render: (_: unknown, record: AgentNode) => renderNodeName(record),
    },
    {
      title: '实例',
      dataIndex: 'jenkinsInstanceId',
      key: 'instance',
      render: (id: string) => instanceNameMap[id] || '—',
    },
    {
      title: '状态',
      dataIndex: 'online',
      key: 'online',
      width: 90,
      render: (online: boolean) => online ? <Tag color="success">在线</Tag> : <Tag>离线</Tag>,
    },
    {
      title: 'Agent 标签',
      key: 'labels',
      render: (_: unknown, record: AgentNode) => {
        const labelList = record.labels ?? []
        return labelList.length ? (
          <Space size={[4, 4]} wrap>
            {labelList.slice(0, 4).map((item) => <Tag key={item}>{item}</Tag>)}
            {labelList.length > 4 && <Tag>+{labelList.length - 4}</Tag>}
          </Space>
        ) : '—'
      },
    },
    {
      title: '系统',
      dataIndex: 'os',
      key: 'os',
      width: 150,
      render: (value?: string) => value || '—',
    },
    {
      title: '最近同步',
      dataIndex: 'lastSyncAt',
      key: 'lastSyncAt',
      width: 130,
      render: (value?: string) => <RelativeTimeText value={value} className="atop-muted" />,
    },
  ]

  const instanceColumns = [
    {
      title: '实例',
      key: 'instance',
      render: (_: unknown, record: JenkinsInstance) => (
        <div className="atop-instance-cell">
          <span className="atop-instance-icon"><ApiOutlined /></span>
          <div className="atop-jenkins-instance-copy">
            <strong>{record.name}</strong>
            <span>{record.url}</span>
            <div className="atop-jenkins-inline-tags">
              {record.isDefault && <Tag color="blue">默认</Tag>}
              {statusTag(record.status)}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '账号',
      dataIndex: 'username',
      key: 'username',
      width: 150,
      render: (value: string) => <span className="atop-code-pill">{value}</span>,
    },
    {
      title: '同步策略',
      dataIndex: 'agentSyncMode',
      key: 'agentSyncMode',
      width: 160,
      render: (value?: string) => syncModeTag(value),
    },
    {
      title: '节点 / 标签',
      key: 'resources',
      width: 160,
      render: (_: unknown, record: JenkinsInstance) => {
        const stats = getInstanceStats(record.id)
        return (
          <div className="atop-jenkins-count-stack">
            <strong>{stats.onlineNodeCount}/{stats.nodeCount} 节点在线</strong>
            <span>{stats.labelCount} 个标签能力</span>
          </div>
        )
      },
    },
    {
      title: '最近检测',
      key: 'lastPingAt',
      width: 150,
      render: (_: unknown, record: JenkinsInstance) => (
        <div className="atop-jenkins-count-stack">
          <strong><RelativeTimeText value={record.lastPingAt} emptyText="—" /></strong>
          <span>{record.updatedAt ? <>更新 <RelativeTimeText value={record.updatedAt} /></> : ''}</span>
        </div>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 190,
      render: (_: unknown, record: JenkinsInstance) => (
        <Space size={6} className="atop-jenkins-actions">
          <Button size="small" icon={<EyeOutlined />} onClick={() => openInstanceNodes(record)}>
            资源
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={syncingIds[record.id]}
            onClick={() => handleSync(record)}
          >
            同步
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: (() => {
                const writeItems = [
                  can('jenkins', 'edit') ? { key: 'edit', icon: <EditOutlined />, label: '编辑实例' } : null,
                  can('jenkins', 'delete') ? { key: 'delete', icon: <DeleteOutlined />, label: '删除实例', danger: true } : null,
                ].filter(Boolean)
                return [
                  { key: 'ping', icon: <ReloadOutlined />, label: '检测连接' },
                  ...(writeItems.length ? [{ type: 'divider' as const }, ...writeItems] : []),
                ]
              })(),
              onClick: ({ key }) => {
                if (key === 'ping') handlePing(record)
                if (key === 'edit') openEdit(record)
                if (key === 'delete') handleDelete(record)
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} loading={checkingIds[record.id]} />
          </Dropdown>
        </Space>
      ),
    },
  ]

  const labelColumns = [
    {
      title: 'Agent 标签',
      dataIndex: 'label',
      key: 'label',
      render: (value: string) => <span className="atop-code-pill">{value}</span>,
    },
    {
      title: '所属实例',
      key: 'instance',
      render: (_: unknown, record: AgentLabel) => (
        record.jenkinsInstanceName || instanceNameMap[record.jenkinsInstanceId] || '—'
      ),
    },
    {
      title: '节点覆盖',
      key: 'nodeCount',
      width: 160,
      render: (_: unknown, record: AgentLabel) => (
        <div className="atop-jenkins-count-stack">
          <strong>{record.onlineCount}/{record.totalCount} 在线</strong>
          <span>来自 assignedLabels</span>
        </div>
      ),
    },
    {
      title: '最近同步',
      dataIndex: 'lastSyncAt',
      key: 'lastSyncAt',
      width: 130,
      render: (value?: string) => <RelativeTimeText value={value} className="atop-muted" />,
    },
  ]

  const renderCodeBlock = (title: string, code: string, copyLabel: string) => (
    <div className="atop-jenkins-template-code">
      <div className="atop-jenkins-template-code-head">
        <strong>{title}</strong>
        <Button size="small" icon={<CopyOutlined />} onClick={() => copyText(code, copyLabel)}>
          复制
        </Button>
      </div>
      <pre>{code}</pre>
    </div>
  )

  const tabItems = [
    {
      key: 'labels',
      label: `Agent 标签 (${labels.length})`,
      children: (
        <div className="atop-jenkins-resource-summary">
          <div>
            <strong>{labels.length}</strong>
            <span>个 Agent 标签</span>
            <small>标签来自 Jenkins 节点 assignedLabels 聚合结果</small>
          </div>
          <Button icon={<EyeOutlined />} onClick={() => openAllResources('labels')}>
            查看全部标签
          </Button>
        </div>
      ),
    },
    {
      key: 'nodes',
      label: `节点池 (${nodes.length})`,
      children: (
        <div className="atop-jenkins-resource-summary">
          <div>
            <strong>{nodes.length}</strong>
            <span>个 Jenkins 节点</span>
            <small>在线 {onlineNodeCount} 个，离线 {Math.max(0, nodes.length - onlineNodeCount)} 个</small>
          </div>
          <Button icon={<EyeOutlined />} onClick={() => openAllResources('nodes')}>
            查看全部节点
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="atop-page-shell atop-jenkins-page">
      <PageHeader
        eyebrow="JENKINS RESOURCE CENTER"
        title="Jenkins 实例与 Agent 资源"
        subtitle="统一管理多个 Jenkins 实例、节点池和标签资源；运行节点由 Jenkins Pipeline 自行调度"
        extra={
          <PermGuard resource="jenkins" action="create">
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增实例</Button>
          </PermGuard>
        }
      />

      <Alert
        className="atop-jenkins-source-alert"
        type="info"
        showIcon
        message="数据来源说明"
        description="平台同步时调用 Jenkins /computer/api/json 读取 computer、offline、assignedLabels 和 monitorData。节点池是一台台 Jenkins Node；Agent 标签是节点 assignedLabels 聚合结果。Jenkins 只有一台机器时，节点池也只会有一条，built-in/master 只是 Jenkins 自带节点或标签。"
      />

      <Card
        className="atop-content-card atop-jenkins-template-card"
        size="small"
        style={{ marginBottom: 14 }}
        title={
          <SectionTitle
            icon={<CodeOutlined />}
            title="Jenkins 接入模板"
            note="把公共函数放进 Jenkins Shared Library 后，Jenkinsfile 只需要调用 atop.running / atop.success / atop.buildJob"
            tone="info"
          />
        }
        extra={
          <Button size="small" type="primary" ghost onClick={() => setTemplateOpen((open) => !open)}>
            {templateOpen ? '收起模板' : '展开模板'}
          </Button>
        }
      >
        {templateOpen ? (
          <>
        <div className="atop-jenkins-template-flow">
          <div>
            <strong>1. 平台触发 Job</strong>
            <span>平台通过 Jenkins 参数注入 ATOP_PAYLOAD，里面包含 task_id、run_id、回调地址和参数。</span>
          </div>
          <div>
            <strong>2. Jenkins 执行业务脚本</strong>
            <span>脚本生成 tag、module、image 等信息后，调用 atop.success(outputs) 回传平台。</span>
          </div>
          <div>
            <strong>3. 平台传给下游</strong>
            <span>下游组件用 ${'{'}nodes.组件ID.outputs.tag{'}'} 或 ${'{'}nodes.组件ID.inputs.BRANCH{'}'} 映射成 Jenkins 参数。</span>
          </div>
        </div>

        <Tabs
          size="small"
          className="atop-jenkins-template-tabs"
          items={[
            {
              key: 'library',
              label: '公共函数',
              children: renderCodeBlock('vars/atop.groovy', ATOP_SHARED_LIBRARY_CODE, '公共函数'),
            },
            {
              key: 'jenkinsfile',
              label: 'Jenkinsfile 示例',
              children: renderCodeBlock('业务 Job 示例', ATOP_JENKINSFILE_EXAMPLE, 'Jenkinsfile 示例'),
            },
            {
              key: 'wait',
              label: 'wait 场景',
              children: renderCodeBlock('Jenkins 内部调用其它 Job', ATOP_JENKINS_WAIT_EXAMPLE, 'wait 示例'),
            },
            {
              key: 'mapping',
              label: '参数映射',
              children: renderCodeBlock('平台组件参数映射', ATOP_MAPPING_EXAMPLE, '参数映射说明'),
            },
          ]}
        />
          </>
        ) : (
          <div className="atop-jenkins-template-collapsed">
            模板已收起，需要复制 Shared Library 或 Jenkinsfile 示例时再展开。
          </div>
        )}
      </Card>

      <div className="atop-metric-grid">
        <div className="atop-metric-card atop-metric-card-info">
          <div className="atop-metric-head">
            <div className="atop-metric-label">Jenkins 实例</div>
            <span className="atop-metric-icon"><ApiOutlined /></span>
          </div>
          <div className="atop-metric-value">{instances.length}</div>
          <div className="atop-metric-foot">支持多实例集中管理</div>
        </div>
        <div className="atop-metric-card atop-metric-card-success">
          <div className="atop-metric-head">
            <div className="atop-metric-label">可达实例</div>
            <span className="atop-metric-icon"><CheckCircleOutlined /></span>
          </div>
          <div className="atop-metric-value">{reachableCount}</div>
          <div className="atop-metric-foot">连接状态来自 Ping 检测</div>
        </div>
        <div className="atop-metric-card">
          <div className="atop-metric-head">
            <div className="atop-metric-label">在线节点</div>
            <span className="atop-metric-icon"><DatabaseOutlined /></span>
          </div>
          <div className="atop-metric-value">{onlineNodeCount}/{nodes.length}</div>
          <div className="atop-metric-foot">按物理 Jenkins Node 统计，不按标签重复计数</div>
        </div>
        <div className="atop-metric-card atop-metric-card-warning">
          <div className="atop-metric-head">
            <div className="atop-metric-label">Agent 标签</div>
            <span className="atop-metric-icon"><ClusterOutlined /></span>
          </div>
          <div className="atop-metric-value">{labels.length}</div>
          <div className="atop-metric-foot">最近同步 <RelativeTimeText value={latestSyncAt} emptyText="—" /></div>
        </div>
      </div>

      <Card
        className="atop-content-card atop-table-card"
        size="small"
        style={{ marginBottom: 14 }}
        title={
          <SectionTitle
            icon={<SettingOutlined />}
            title="实例配置"
            note="实例负责 Jenkins 连接、Job 触发和节点发现；节点和标签由同步动作刷新"
            tone="info"
          />
        }
        styles={{ body: { padding: '12px 0 0' } }}
      >
        {instances.length === 0 && !loadingInstances ? (
          <EmptyState description="暂无 Jenkins 实例" createLabel="新增实例" onCreate={openCreate} resource="jenkins" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            loading={loadingInstances}
            columns={instanceColumns}
            dataSource={instances}
            pagination={false}
          />
        )}
      </Card>

      <Card
        className="atop-content-card atop-table-card"
        size="small"
        title={
          <SectionTitle
            icon={<ClusterOutlined />}
            title="Agent 资源视图"
            note="主页面只展示可筛选清单；查看某个实例或标签时再进入分页弹窗，避免上百节点撑爆页面"
            tone="success"
          />
        }
        styles={{ body: { padding: '12px 0 0' } }}
      >
        <Tabs defaultActiveKey={defaultAgentView} items={tabItems} size="middle" tabBarStyle={{ padding: '0 12px', marginBottom: 12 }} />
      </Card>

      <Modal
        title={editing ? '编辑 Jenkins 实例' : '新增 Jenkins 实例'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => cancelWithConfirm(() => { setModalOpen(false); form.resetFields() })}
        confirmLoading={saving}
        maskClosable={false}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={680}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <div className="atop-jenkins-form-grid">
            <Form.Item name="name" label="实例名称" rules={[{ required: true }, maxLenRule('jenkinsName', '实例名称')]}>
              <Input placeholder="如：生产 Jenkins" prefix={<ApiOutlined />} {...inputLimit('jenkinsName')} />
            </Form.Item>
            <Form.Item name="url" label="Jenkins 地址" rules={[{ required: true }, { type: 'url' }, maxLenRule('url', 'Jenkins 地址')]}>
              <Input placeholder="http://jenkins.example.com" prefix={<LinkOutlined />} {...inputLimit('url')} />
            </Form.Item>
          </div>
          <div className="atop-jenkins-form-grid">
            <Form.Item name="username" label="用户名" rules={[{ required: true }, maxLenRule('jenkinsUsername', '用户名')]}>
              <Input placeholder="Jenkins 用户名" {...inputLimit('jenkinsUsername')} />
            </Form.Item>
            <Form.Item
              name="apiToken"
              label="API Token"
              rules={editing ? [maxLenRule('token', 'API Token')] : [{ required: true, message: '新增实例需要 API Token' }, maxLenRule('token', 'API Token')]}
              extra={editing ? '不填写则保持原 Token 不变' : '用于触发 Job、读取节点和检测连接'}
            >
              <Input.Password placeholder={editing ? '保持原 Token' : 'Jenkins API Token'} {...inputLimit('token')} />
            </Form.Item>
          </div>
          <Form.Item
            name="viewerToken"
            label="查看日志 Token（可选）"
            rules={[maxLenRule('token', '查看日志 Token')]}
            extra={editing ? '不填写则保持原 Token 不变' : '用于 Jenkins 日志查看场景，可不填'}
          >
            <Input.Password placeholder="可选" {...inputLimit('token')} />
          </Form.Item>
          <Form.Item name="agentSyncMode" label="Agent 同步策略" rules={[{ required: true }]}>
            <Radio.Group className="atop-jenkins-radio-grid">
              <Radio.Button value="all">
                <div>
                  <strong>同步全部节点</strong>
                  <span>适合多实例、多 Agent 的资源池视图</span>
                </div>
              </Radio.Button>
              <Radio.Button value="fixed">
                <div>
                  <strong>固定机器清单</strong>
                  <span>只维护白名单节点，适合资源治理或专用机器清单</span>
                </div>
              </Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.agentSyncMode !== cur.agentSyncMode}
          >
            {({ getFieldValue }) => getFieldValue('agentSyncMode') === 'fixed' && (
              <Form.Item
                name="fixedNodes"
                label="固定机器节点"
                rules={[{ required: true, message: '请至少填写一个固定机器节点' }]}
                extra="左侧从已同步节点中搜索选择，适合从上百台机器里挑选测试资源；也可以在右侧清单中随时移除。"
                valuePropName="targetKeys"
              >
                <Transfer
                  className="atop-jenkins-node-transfer"
                  dataSource={fixedNodeOptions}
                  rowKey={(item) => item.key}
                  showSearch
                  oneWay
                  pagination={{ pageSize: 10 }}
                  listStyle={{ width: '50%', height: 330 }}
                  titles={['可选 Jenkins 节点', '固定机器清单']}
                  locale={{
                    itemUnit: '台',
                    itemsUnit: '台',
                    searchPlaceholder: '搜索节点、实例、标签、系统',
                    notFoundContent: loadingNodes ? '节点加载中' : '暂无节点，先同步节点',
                  }}
                  filterOption={(input, item) => matchesKeyword(`${item.title} ${item.description}`, input)}
                  render={(item) => {
                    const node = item.node
                    return (
                      <div className="atop-transfer-node">
                        <strong>{item.title}</strong>
                        <span>{instanceNameMap[node.jenkinsInstanceId] || '未同步节点'} · {node.online ? '在线' : '离线'} · {node.os || '未知系统'}</span>
                      </div>
                    )
                  }}
                />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item name="isDefault" label="默认实例">
            <Radio.Group>
              <Radio value={false}>普通实例</Radio>
              <Radio value={true}>设为默认</Radio>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={nodeModal.title}
        open={nodeModal.open}
        onCancel={() => setNodeModal((prev) => ({ ...prev, open: false }))}
        footer={null}
        width={980}
        destroyOnClose
      >
        <Alert type="info" showIcon message={nodeModal.note} style={{ marginBottom: 12 }} />
        <div className="atop-toolbar-card" style={{ marginBottom: 12 }}>
          <SearchOutlined style={{ color: '#2563EB' }} />
          <Input.Search
            allowClear
            placeholder="搜索节点、标签、系统或实例"
            style={{ width: 320 }}
            value={modalKeyword}
            onChange={(event) => setModalKeyword(event.target.value)}
          />
          <Tag color="blue">标签 {modalLabels.length}</Tag>
          <Tag color="green">节点 {modalNodes.length}</Tag>
        </div>
        <Tabs
          defaultActiveKey={nodeModal.defaultTab || 'nodes'}
          items={[
            {
              key: 'labels',
              label: `Agent 标签 (${modalLabels.length})`,
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  loading={nodeModal.loading || loadingLabels}
                  columns={labelColumns}
                  dataSource={modalLabels}
                  pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 条` }}
                  scroll={{ y: 420 }}
                />
              ),
            },
            {
              key: 'nodes',
              label: `节点池 (${modalNodes.length})`,
              children: (
                <Table
                  rowKey={(record) => `${record.jenkinsInstanceId}-${record.nodeId}`}
                  size="small"
                  loading={nodeModal.loading || loadingNodes}
                  columns={nodeColumns}
                  dataSource={modalNodes}
                  pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 条` }}
                  scroll={{ y: 420 }}
                />
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}
