import { useState } from 'react'
import useSWR, { mutate } from 'swr'
import {
  Button, Table, Tag, Switch, Space, Form, Input,
  Select, message, Tooltip, Popconfirm, Modal, Checkbox, Divider,
  Tabs, Alert,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  BellOutlined, InfoCircleOutlined, LinkOutlined,
  PlusCircleOutlined, MinusCircleOutlined, SendOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import PageHeader from '@/components/common/PageHeader'
import { PermGuard, usePermission } from '@/hooks/usePermission'
import { useDimensions } from '@/hooks/useDimensions'
import { useTableLayout } from '@/hooks/useTableLayout'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

const SWR_KEY = '/notifications/rules'
const WEBHOOK_CHANNELS = ['dingtalk', 'feishu', 'webhook']
const DEFAULT_CUSTOM_WEBHOOK_BODY = `{
  "event": "\${EVENT}",
  "pipelineName": "\${PIPELINE_NAME}",
  "status": "\${STATUS_CODE}",
  "passRate": "\${PASS_RATE}",
  "runId": "\${RUN_ID}",
  "detailUrl": "\${DETAIL_URL}"
}`

const EVENT_OPTIONS = [
  { value: 'pipeline_complete', label: '流水线运行完成' },
  { value: 'pipeline_failed',   label: '流水线运行失败' },
  { value: 'pipeline_aborted',  label: '流水线被中止' },
]
const EVENT_VALUES = EVENT_OPTIONS.map((event) => event.value)

const CHANNEL_OPTIONS = [
  { value: 'inapp',    label: '站内消息' },
  { value: 'email',    label: '邮件' },
  { value: 'dingtalk', label: '钉钉 Webhook' },
  { value: 'feishu',   label: '飞书 Webhook' },
  { value: 'webhook',  label: '自定义 Webhook' },
]
const EVENT_LABELS = Object.fromEntries(EVENT_OPTIONS.map((item) => [item.value, item.label]))
const CHANNEL_LABELS = Object.fromEntries(CHANNEL_OPTIONS.map((item) => [item.value, item.label]))

const RECIPIENT_TYPE_OPTIONS = [
  { value: 'trigger_user', label: '触发人自己' },
  { value: 'role_pm',      label: '项目负责人（角色）' },
  { value: 'all_members',  label: '全体成员' },
  { value: 'custom',       label: '自定义邮箱' },
]

const METHOD_OPTIONS = ['POST', 'PUT', 'PATCH', 'GET'].map((method) => ({ label: method, value: method }))

type KeyValue = { key?: string; value?: string }

interface ChannelConfig {
  url?: string
  method?: string
  headers?: KeyValue[]
  queryParams?: KeyValue[]
  bodyTemplate?: string
}

type ChannelConfigs = Record<string, ChannelConfig>

interface Rule {
  id: string
  name: string
  enabled: boolean
  eventsJson: string
  scope: string
  projectIdsJson?: string
  pipelineIdsJson?: string
  channelsJson: string
  recipientsJson?: string
  webhookUrl?: string
  channelConfigsJson?: string
  titleTemplate?: string
  bodyTemplate?: string
  createdAt: string
}

function parseJSON<T>(s: string | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

function normalizeEvents(events: string[]): string[] {
  return events.filter((event) => EVENT_VALUES.includes(event))
}

function webhookChannels(channels: string[]) {
  return channels.filter((channel) => WEBHOOK_CHANNELS.includes(channel))
}

function sanitizeKVList(items?: KeyValue[]) {
  return (items ?? [])
    .map((item) => ({ key: item?.key?.trim(), value: item?.value ?? '' }))
    .filter((item) => item.key)
}

function sanitizeChannelConfigs(raw: ChannelConfigs, channels: string[]): ChannelConfigs {
  const result: ChannelConfigs = {}
  webhookChannels(channels).forEach((channel) => {
    const cfg = raw?.[channel] ?? {}
    result[channel] = {
      url: cfg.url?.trim(),
      method: channel === 'webhook' ? (cfg.method || 'POST') : undefined,
      queryParams: sanitizeKVList(cfg.queryParams),
      headers: sanitizeKVList(cfg.headers),
      bodyTemplate: channel === 'webhook' ? cfg.bodyTemplate : undefined,
    }
  })
  return result
}

function firstWebhookUrl(configs: ChannelConfigs, channels: string[]) {
  for (const channel of webhookChannels(channels)) {
    const url = configs[channel]?.url?.trim()
    if (url) return url
  }
  return undefined
}

function findRuleConflicts(rules: Rule[], events: string[], channels: string[], editingID?: string) {
  const eventSet = new Set(normalizeEvents(events ?? []))
  const channelSet = new Set(channels ?? [])
  const seen = new Set<string>()
  const conflicts: Array<{ ruleName: string; event: string; channel: string }> = []
  if (eventSet.size === 0 || channelSet.size === 0) return conflicts

  rules.forEach((rule) => {
    if (editingID && rule.id === editingID) return
    const ruleEvents = normalizeEvents(parseJSON<string[]>(rule.eventsJson, []))
    const ruleChannels = parseJSON<string[]>(rule.channelsJson, [])
    ruleEvents.forEach((event) => {
      if (!eventSet.has(event)) return
      ruleChannels.forEach((channel) => {
        if (!channelSet.has(channel)) return
        const key = `${rule.id}:${event}:${channel}`
        if (seen.has(key)) return
        seen.add(key)
        conflicts.push({
          ruleName: rule.name || rule.id,
          event,
          channel,
        })
      })
    })
  })
  return conflicts
}

function formatConflictMessage(conflicts: Array<{ ruleName: string; event: string; channel: string }>) {
  if (conflicts.length === 0) return ''
  const details = conflicts.slice(0, 4).map((item) => (
    `${item.ruleName}（${EVENT_LABELS[item.event] ?? item.event} / ${CHANNEL_LABELS[item.channel] ?? item.channel}）`
  ))
  const suffix = conflicts.length > 4 ? ' 等' : ''
  return `已存在相同事件和渠道的通知规则：${details.join('；')}${suffix}`
}

export default function NotificationRulePage() {
  const { can } = usePermission()
  const canEditRule = can('notification_rule', 'edit')
  const { data, isLoading } = useSWR(SWR_KEY,
    () => client.get('/notifications/rules').then(r => r.data.data?.items ?? []))
  const rules: Rule[] = data ?? []

  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [editing, setEditing]       = useState<Rule | null>(null)
  const [saving, setSaving]         = useState(false)
  const [testingRuleId, setTestingRuleId] = useState<string>()
  const [form] = Form.useForm()
  const [channelsValue, setChannelsValue] = useState<string[]>(['inapp'])
  const [scopeValue, setScopeValue]       = useState<string>('global')
  const [recipientType, setRecipientType] = useState<string>('trigger_user')
  const [activeWebhookChannel, setActiveWebhookChannel] = useState<string>('dingtalk')
  const { projectOptions } = useDimensions()
  const { tableProps } = useTableLayout({ offsetY: 290 })
  const watchedEvents = Form.useWatch('events', form) ?? []

  const selectedWebhookChannels = webhookChannels(channelsValue)
  const duplicateConflicts = findRuleConflicts(rules, watchedEvents, channelsValue, editing?.id)
  const duplicateConflictMessage = formatConflictMessage(duplicateConflicts)
  const enabledCount = rules.filter((rule) => rule.enabled).length
  const eventCount = new Set(rules.flatMap((rule) => normalizeEvents(parseJSON<string[]>(rule.eventsJson, [])))).size

  const seedChannelConfigs = (channels: string[], existing: ChannelConfigs = {}) => {
    const next: ChannelConfigs = { ...existing }
    if (channels.includes('webhook')) {
      next.webhook = {
        method: 'POST',
        bodyTemplate: DEFAULT_CUSTOM_WEBHOOK_BODY,
        ...(next.webhook ?? {}),
      }
    }
    form.setFieldValue('channelConfigs', next)
  }

  const warnIfDuplicate = (events: string[], channels: string[]) => {
    const content = formatConflictMessage(findRuleConflicts(rules, events, channels, editing?.id))
    if (content) {
      message.warning({ content, key: 'notification-rule-conflict', duration: 4 })
    }
  }

  const handleEventsChange = (value: string[]) => {
    warnIfDuplicate(value, channelsValue)
  }

  const handleChannelsChange = (value: string[]) => {
    setChannelsValue(value)
    seedChannelConfigs(value, form.getFieldValue('channelConfigs') ?? {})
    const nextWebhookChannels = webhookChannels(value)
    if (!nextWebhookChannels.includes(activeWebhookChannel)) {
      setActiveWebhookChannel(nextWebhookChannels[0] ?? 'dingtalk')
    }
    warnIfDuplicate(form.getFieldValue('events') ?? [], value)
  }

  const openCreate = () => {
    setEditing(null)
    setChannelsValue(['inapp'])
    setActiveWebhookChannel('dingtalk')
    form.resetFields()
    form.setFieldsValue({
      scope: 'global',
      channels: ['inapp'],
      channelConfigs: { webhook: { method: 'POST', bodyTemplate: DEFAULT_CUSTOM_WEBHOOK_BODY } },
      recipientType: 'trigger_user',
      enabled: true,
    })
    setScopeValue('global')
    setRecipientType('trigger_user')
    setRuleModalOpen(true)
  }

  const openEdit = (rule: Rule) => {
    setEditing(rule)
    const channels = parseJSON<string[]>(rule.channelsJson, ['inapp'])
    const recipients = parseJSON<{type:string;projectIds?:string[];emails?:string[]}>(rule.recipientsJson, { type: 'trigger_user' })
    const channelConfigs = parseJSON<ChannelConfigs>(rule.channelConfigsJson, {})
    webhookChannels(channels).forEach((channel) => {
      if (!channelConfigs[channel]) channelConfigs[channel] = {}
      if (!channelConfigs[channel].url && rule.webhookUrl) channelConfigs[channel].url = rule.webhookUrl
    })
    if (!channelConfigs.webhook?.method) {
      channelConfigs.webhook = {
        method: 'POST',
        bodyTemplate: DEFAULT_CUSTOM_WEBHOOK_BODY,
        ...(channelConfigs.webhook ?? {}),
      }
    }

    form.setFieldsValue({
      name:            rule.name,
      enabled:         rule.enabled,
      events:          normalizeEvents(parseJSON<string[]>(rule.eventsJson, [])),
      scope:           rule.scope,
      projectIds:      parseJSON<string[]>(rule.projectIdsJson, []),
      channels,
      channelConfigs,
      titleTemplate:   rule.titleTemplate,
      bodyTemplate:    rule.bodyTemplate,
      recipientType:   recipients.type,
      customEmails:    recipients.emails?.join(','),
    })
    setChannelsValue(channels)
    setActiveWebhookChannel(webhookChannels(channels)[0] ?? 'dingtalk')
    setScopeValue(rule.scope)
    setRecipientType(recipients.type)
    setRuleModalOpen(true)
  }

  const handleSave = async () => {
    const vals = await form.validateFields()
    const channels = vals.channels ?? ['inapp']
    const conflicts = findRuleConflicts(rules, vals.events ?? [], channels, editing?.id)
    const conflictMessage = formatConflictMessage(conflicts)
    if (conflictMessage) {
      form.setFields([
        { name: 'events', errors: ['事件和渠道组合已存在'] },
        { name: 'channels', errors: ['事件和渠道组合已存在'] },
      ])
      message.error(conflictMessage)
      return
    }
    setSaving(true)
    const channelConfigs = sanitizeChannelConfigs(vals.channelConfigs ?? {}, channels)
    const customEmails = vals.customEmails
      ? vals.customEmails.split(/[,\n]+/).map((e: string) => e.trim()).filter(Boolean)
      : []
    const payload = {
      name:               vals.name,
      enabled:            vals.enabled ?? true,
      eventsJson:         JSON.stringify(normalizeEvents(vals.events ?? [])),
      scope:              vals.scope ?? 'global',
      projectIdsJson:     vals.scope === 'project' ? JSON.stringify(vals.projectIds ?? []) : '[]',
      channelsJson:       JSON.stringify(channels),
      recipientsJson:     JSON.stringify({
        type:   vals.recipientType,
        emails: vals.recipientType === 'custom' ? customEmails : undefined,
      }),
      webhookUrl:         firstWebhookUrl(channelConfigs, channels),
      channelConfigsJson: JSON.stringify(channelConfigs),
      titleTemplate:      vals.titleTemplate,
      bodyTemplate:       vals.bodyTemplate,
    }
    try {
      if (editing) {
        await client.put(`/notifications/rules/${editing.id}`, payload)
        message.success('规则已更新')
      } else {
        await client.post('/notifications/rules', payload)
        message.success('规则已创建')
      }
      mutate(SWR_KEY)
      setRuleModalOpen(false)
    } catch { /* handled */ } finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    await client.delete(`/notifications/rules/${id}`)
    message.success('已删除')
    mutate(SWR_KEY)
  }

  const handleToggle = async (rule: Rule) => {
    await client.put(`/notifications/rules/${rule.id}/toggle`, {})
    mutate(SWR_KEY)
  }

  const handleTestRule = async (rule: Rule) => {
    setTestingRuleId(rule.id)
    try {
      const resp = await client.post(`/notifications/rules/${rule.id}/test`, {})
      const data = resp.data?.data ?? {}
      const results = data.results ?? []
      const failed = results.filter((item: any) => !item.ok)
      if (failed.length > 0) {
        message.warning(`测试已完成，${failed.length} 个渠道失败：${failed.map((item: any) => item.channel).join('、')}`)
      } else {
        const succeededChannels = new Set(results.filter((item: any) => item.ok).map((item: any) => item.channel))
        const summary = [
          succeededChannels.has('inapp') && data.recipientCount ? `${data.recipientCount} 个站内用户` : '',
          succeededChannels.has('email') && data.emailCount ? `${data.emailCount} 个邮箱` : '',
        ].filter(Boolean).join('、')
        message.success(summary ? `测试通知已按规则发送给 ${summary}` : '测试通知已真实发送，请检查对应渠道')
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || '测试通知发送失败')
    } finally {
      setTestingRuleId(undefined)
    }
  }

  const renderKVList = (name: (string | number)[], addText: string, keyPlaceholder: string, valuePlaceholder: string) => (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <div className="atop-notify-kv-list">
          {fields.map((field) => (
            <div className="atop-notify-kv-row" key={field.key}>
              <Form.Item name={[field.name, 'key']} rules={[maxLenRule('variableKey', '名称')]}>
                <Input size="small" placeholder={keyPlaceholder} {...inputLimit('variableKey')} />
              </Form.Item>
              <Form.Item name={[field.name, 'value']} rules={[maxLenRule('variableValue', '值')]}>
                <Input size="small" placeholder={valuePlaceholder} {...inputLimit('variableValue')} />
              </Form.Item>
              <Button size="small" type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} aria-label="删除参数" />
            </div>
          ))}
          <Button size="small" icon={<PlusCircleOutlined />} onClick={() => add({ key: '', value: '' })}>{addText}</Button>
        </div>
      )}
    </Form.List>
  )

  const renderWebhookConfig = (channel: string) => {
    const title = CHANNEL_OPTIONS.find((item) => item.value === channel)?.label ?? channel
    const placeholder = channel === 'dingtalk'
      ? 'https://oapi.dingtalk.com/robot/send?access_token=...'
      : channel === 'feishu'
      ? 'https://open.feishu.cn/open-apis/bot/v2/hook/...'
      : 'https://api.example.com/notify'

    return (
      <div className="atop-notify-webhook-panel" key={channel}>
        <div className="atop-notify-section-head">
          <span className="atop-notify-section-icon"><LinkOutlined /></span>
          <div>
            <strong>{title}</strong>
            <small>{channel === 'webhook' ? 'API 地址、参数、Header、请求体' : '该渠道独立配置地址和可选参数'}</small>
          </div>
        </div>
        <div className="atop-notify-channel-note">
          当前 Tab 的地址和参数只对「{title}」生效，不会和其他渠道共用。
        </div>
        <Form.Item
          name={['channelConfigs', channel, 'url']}
          label="Webhook URL"
          rules={[{ required: true, message: `请输入 ${title} 地址` }, maxLenRule('url', `${title} 地址`)]}
        >
          <Input placeholder={placeholder} {...inputLimit('url')} />
        </Form.Item>

        {channel !== 'webhook' && (
          <>
            <Form.Item label="Query 参数（可选）">
              {renderKVList(['channelConfigs', channel, 'queryParams'], '添加 Query 参数', '如：token', '如：${RUN_ID}')}
            </Form.Item>
            <Form.Item label="请求 Header（可选）">
              {renderKVList(['channelConfigs', channel, 'headers'], '添加 Header', '如：Authorization', '如：Bearer xxx')}
            </Form.Item>
          </>
        )}

        {channel === 'webhook' && (
          <>
            <Form.Item name={['channelConfigs', 'webhook', 'method']} label="请求方法" initialValue="POST">
              <Select options={METHOD_OPTIONS} />
            </Form.Item>
            <Form.Item label="Query 参数">
              {renderKVList(['channelConfigs', 'webhook', 'queryParams'], '添加 Query 参数', '如：token', '如：${RUN_ID}')}
            </Form.Item>
            <Form.Item label="请求 Header">
              {renderKVList(['channelConfigs', 'webhook', 'headers'], '添加 Header', '如：Authorization', '如：Bearer xxx')}
            </Form.Item>
            <Form.Item
              name={['channelConfigs', 'webhook', 'bodyTemplate']}
              label="请求体模板"
              rules={[maxLenRule('templateBody', '请求体模板')]}
            >
              <Input.TextArea rows={7} placeholder={DEFAULT_CUSTOM_WEBHOOK_BODY} {...inputLimit('templateBody')} />
            </Form.Item>
          </>
        )}
      </div>
    )
  }

  const columns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      render: (v: string, r: Rule) => (
        <Space>
          <BellOutlined style={{ color: r.enabled ? '#2563EB' : '#9C9A92' }} />
          <span style={{ fontWeight: 500 }}>{v}</span>
          {!r.enabled && <Tag color="default">已禁用</Tag>}
        </Space>
      ),
    },
    {
      title: '监听事件',
      dataIndex: 'eventsJson',
      render: (v: string) => {
        const evts = normalizeEvents(parseJSON<string[]>(v, []))
        return (
          <Space wrap>
            {evts.map(e => {
              const opt = EVENT_OPTIONS.find(o => o.value === e)
              return <Tag key={e} color="blue">{opt?.label ?? e}</Tag>
            })}
            {evts.length === 0 && <span style={{ color: '#9C9A92' }}>未配置</span>}
          </Space>
        )
      },
    },
    {
      title: '通知渠道',
      dataIndex: 'channelsJson',
      render: (v: string, r: Rule) => {
        const chs = parseJSON<string[]>(v, [])
        const configured = webhookChannels(chs).filter((channel) => {
          const configs = parseJSON<ChannelConfigs>(r.channelConfigsJson, {})
          return configs[channel]?.url || r.webhookUrl
        }).length
        return (
          <Space wrap>
            {chs.map(c => {
              const opt = CHANNEL_OPTIONS.find(o => o.value === c)
              return <Tag key={c}>{opt?.label ?? c}</Tag>
            })}
            {configured > 0 && <Tag color="green">Webhook {configured}</Tag>}
          </Space>
        )
      },
    },
    {
      title: '作用范围',
      dataIndex: 'scope',
      render: (v: string) => v === 'global' ? <Tag color="purple">全局</Tag> : <Tag color="orange">指定项目</Tag>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      render: (_: boolean, r: Rule) => (
        <Tooltip title={canEditRule ? undefined : '需要通知规则编辑权限'}>
          <Switch
            size="small"
            checked={r.enabled}
            disabled={!canEditRule}
            onChange={() => handleToggle(r)}
          />
        </Tooltip>
      ),
    },
    {
      title: '操作',
      width: 152,
      render: (_: unknown, r: Rule) => (
        <div className="atop-action-row">
          <PermGuard resource="notification_rule" action="edit"><Tooltip title="发送测试通知"><Button className="atop-icon-mini" size="small" icon={<SendOutlined />} loading={testingRuleId === r.id} aria-label="发送测试通知" onClick={() => handleTestRule(r)} /></Tooltip></PermGuard>
          <PermGuard resource="notification_rule" action="edit"><Tooltip title="编辑"><Button className="atop-icon-mini" size="small" icon={<EditOutlined />} aria-label="编辑通知规则" onClick={() => openEdit(r)} /></Tooltip></PermGuard>
          <PermGuard resource="notification_rule" action="delete"><Popconfirm title="确认删除此规则？" onConfirm={() => handleDelete(r.id)}>
            <Tooltip title="删除"><Button className="atop-icon-mini" size="small" danger icon={<DeleteOutlined />} aria-label="删除通知规则" /></Tooltip>
          </Popconfirm></PermGuard>
        </div>
      ),
    },
  ]

  return (
    <div className="atop-page-shell">
      <PageHeader
        eyebrow="NOTIFICATION CONTROL"
        title="通知规则"
        subtitle="统一管理事件触发、通知渠道和接收人，让失败、完成、中止等消息有清晰出口。"
        extra={
          <PermGuard resource="notification_rule" action="create"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建规则
          </Button></PermGuard>
        }
      />

      <div className="atop-rule-card-grid">
        <div className="atop-rule-summary-card"><span>规则总数</span><strong>{rules.length}</strong></div>
        <div className="atop-rule-summary-card"><span>启用中</span><strong>{enabledCount}</strong></div>
        <div className="atop-rule-summary-card"><span>覆盖事件</span><strong>{eventCount}</strong></div>
      </div>

      <div className="atop-content-card atop-table-card">
        <Table
          {...tableProps}
          rowKey="id"
          columns={columns}
          dataSource={rules}
          loading={isLoading}
        />
      </div>

      <Modal
        className="atop-notify-rule-modal"
        title={editing ? '编辑通知规则' : '新建通知规则'}
        open={ruleModalOpen}
        onCancel={() => setRuleModalOpen(false)}
        width={920}
        centered
        maskClosable={false}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => setRuleModalOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" className="atop-notify-rule-form">
          <div className="atop-notify-section">
            <div className="atop-notify-section-title">规则条件</div>
            <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }, maxLenRule('name', '规则名称')]}>
              <Input placeholder="如：流水线失败通知项目负责人" {...inputLimit('name')} />
            </Form.Item>

            <Form.Item name="events" label="监听事件" rules={[{ required: true, message: '请至少选择一个事件' }]}>
              <Checkbox.Group
                options={EVENT_OPTIONS}
                className="atop-notify-checkbox-list"
                onChange={v => handleEventsChange(v as string[])}
              />
            </Form.Item>

            <Form.Item name="scope" label="作用范围">
              <Select
                options={[
                  { value: 'global',  label: '全局（所有项目）' },
                  { value: 'project', label: '指定项目' },
                ]}
                onChange={(v: string) => setScopeValue(v)}
              />
            </Form.Item>

            {scopeValue === 'project' && (
              <Form.Item name="projectIds" label="指定项目" rules={[{ required: true, message: '请选择至少一个项目' }]}>
                <Select
                  mode="multiple"
                  placeholder="选择项目（可多选）"
                  options={projectOptions}
                />
              </Form.Item>
            )}
          </div>

          <Divider />

          <div className="atop-notify-section">
            <div className="atop-notify-section-title">通知渠道</div>
            <Form.Item name="channels" label="渠道" rules={[{ required: true, message: '请至少选择一个渠道' }]}>
              <Checkbox.Group
                options={CHANNEL_OPTIONS}
                className="atop-notify-checkbox-list"
                onChange={v => handleChannelsChange(v as string[])}
              />
            </Form.Item>

            {duplicateConflictMessage && (
              <Alert
                type="warning"
                showIcon
                className="atop-notify-conflict-alert"
                message={duplicateConflictMessage}
              />
            )}

            {selectedWebhookChannels.length > 0 && (
              <div className="atop-notify-webhook-tabs">
                <Tabs
                  activeKey={activeWebhookChannel}
                  onChange={setActiveWebhookChannel}
                  items={selectedWebhookChannels.map((channel) => ({
                    key: channel,
                    label: CHANNEL_LABELS[channel] ?? channel,
                    forceRender: true,
                    children: renderWebhookConfig(channel),
                  }))}
                />
              </div>
            )}
          </div>

          <Divider />

          <div className="atop-notify-section">
            <div className="atop-notify-section-title">接收人与模板</div>
            <Form.Item name="recipientType" label="接收人（站内消息 / 邮件）">
              <Select
                options={RECIPIENT_TYPE_OPTIONS}
                onChange={(v: string) => setRecipientType(v)}
              />
            </Form.Item>

            {recipientType === 'custom' && (
              <Form.Item
                name="customEmails"
                label="自定义接收邮箱"
                rules={[{ required: true, message: '请输入接收人邮箱' }, maxLenRule('emails', '自定义接收邮箱')]}
                extra="多个邮箱用逗号或换行分隔"
              >
                <Input.TextArea
                  rows={3}
                  placeholder={"user1@example.com,user2@example.com"}
                  {...inputLimit('emails')}
                />
              </Form.Item>
            )}

            <Form.Item name="titleTemplate" label="通知标题模板（留空使用默认）" rules={[maxLenRule('templateTitle', '通知标题模板')]}>
              <Input placeholder="${PIPELINE_NAME} 运行${STATUS}" {...inputLimit('templateTitle')} />
            </Form.Item>

            <Form.Item
              name="bodyTemplate"
              rules={[maxLenRule('templateBody', '通知内容模板')]}
              label={
                <span>
                  通知内容模板（留空使用默认）
                  <Tooltip title="可用变量：${PIPELINE_NAME} ${STATUS} ${STATUS_CODE} ${PASS_RATE} ${FAILED_COUNT} ${TOTAL_COUNT} ${TRIGGERED_BY} ${DURATION} ${DETAIL_URL} ${RUN_ID}">
                    <InfoCircleOutlined style={{ marginLeft: 4, color: '#9C9A92' }} />
                  </Tooltip>
                </span>
              }
            >
              <Input.TextArea rows={3} placeholder="流水线 ${PIPELINE_NAME} 运行${STATUS}，通过率 ${PASS_RATE}%..." {...inputLimit('templateBody')} />
            </Form.Item>

            <Form.Item name="enabled" label="启用规则" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  )
}
