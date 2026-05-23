import { useState } from 'react'
import useSWR from 'swr'
import {
  Card, Table, Button, Space, Tag, Form, Input, Select,
  Modal, Alert, message, Segmented,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ExclamationCircleOutlined, KeyOutlined } from '@ant-design/icons'
import { varsApi } from '@/api/settings'
import { useModalForm } from '@/hooks/useModalForm'
import { useDimensions } from '@/hooks/useDimensions'
import { useTableLayout } from '@/hooks/useTableLayout'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import { PermGuard } from '@/hooks/usePermission'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import EmptyState from '@/components/common/EmptyState'
import { showConfirm } from '@/components/common/ConfirmModal'
import type { GlobalVar } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

type ScopeFilter = 'all' | 'system' | 'project'

export default function VarsPage() {
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<GlobalVar | null>(null)
  const [form] = Form.useForm()
  const { cancelWithConfirm, markClean } = useModalForm(form)
  const { projectOptions } = useDimensions()
  const { tableProps } = useTableLayout({ offsetY: 290 })

  const swrKey = ['vars', scope]
  const { data: vars = [], isLoading, mutate } = useSWR(
    swrKey,
    () => varsApi.list(scope === 'all' ? undefined : scope),
    { revalidateOnFocus: false }
  )

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    const initial = { scope: 'system' }
    form.setFieldsValue(initial)
    markClean(initial)
    setModalOpen(true)
  }

  const openEdit = (record: GlobalVar) => {
    const initial = {
      key: record.key,
      value: record.value,
      scope: record.scope,
      projectId: record.projectId,
    }
    setEditing(record)
    form.setFieldsValue(initial)
    markClean(initial)
    setModalOpen(true)
  }

  const handleSave = async (force = false) => {
    const values = await form.validateFields()
    try {
      if (editing) {
        const payload = force ? { ...values, force: true } : values
        const resp = await varsApi.update(editing.id, payload)
        // Backend returns needConfirm when scope narrows system→project
        if ((resp as any).needConfirm) {
          const { affectedCount, message: warnMsg } = resp as any
          Modal.confirm({
            title: '确认修改作用域？',
            icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
            width: 480,
            content: (
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ marginBottom: 8 }}>{warnMsg}</div>
                {affectedCount > 0 && (
                  <Alert
                    type="warning" showIcon
                    message={`预计影响约 ${affectedCount} 个测试集，建议修改前与相关测试负责人确认。`}
                    style={{ fontSize: 12 }}
                  />
                )}
              </div>
            ),
            okText: '确认修改', cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: () => handleSave(true),
          })
          return
        }
        message.success('保存成功')
      } else {
        await varsApi.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      mutate()
    } catch { /* handled */ }
  }

  const handleDelete = (record: GlobalVar) => {
    showConfirm({
      title: `确认删除变量「${record.key}」？`,
      content: '删除后引用该变量的测试集脚本将无法注入此变量值，请确认无测试集使用。',
      onOk: async () => {
        await varsApi.delete(record.id)
        message.success('已删除')
        mutate()
      },
    })
  }

  const cols = [
    {
      title: '变量名', dataIndex: 'key', key: 'key',
      render: (k: string) => (
        <code className="atop-code-pill">
          {`\${${k}}`}
        </code>
      ),
    },
    {
      title: '当前值', dataIndex: 'value', key: 'value',
      render: (v: string) => (
        <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#5F5E5A', wordBreak: 'break-all' }}>
          {v.length > 60 ? v.slice(0, 60) + '…' : v}
        </span>
      ),
    },
    {
      title: '作用域', key: 'scope',
      render: (_: unknown, row: GlobalVar) => (
        row.scope === 'system'
          ? <Tag color="red" style={{ fontSize: 11 }}>系统级</Tag>
          : <Tag color="green" style={{ fontSize: 11 }}>项目级 · {row.projectId}</Tag>
      ),
    },
    {
      title: '最后更新', dataIndex: 'updatedAt', key: 'updated', width: 110,
      render: (t: string) => <RelativeTimeText value={t} style={{ fontSize: 12, color: '#9C9A92' }} />,
    },
    {
      title: '操作', key: 'action', width: 140,
      render: (_: unknown, row: GlobalVar) => (
        <div className="atop-action-row">
          <PermGuard resource="vars" action="edit"><Button className="atop-icon-mini" size="small" icon={<EditOutlined />} aria-label="编辑变量" onClick={() => openEdit(row)} /></PermGuard>
          <PermGuard resource="vars" action="delete"><Button className="atop-icon-mini" size="small" danger icon={<DeleteOutlined />} aria-label="删除变量" onClick={() => handleDelete(row)} /></PermGuard>
        </div>
      ),
    },
  ]

  const systemCount = vars.filter((item) => item.scope === 'system').length
  const projectCount = vars.filter((item) => item.scope === 'project').length

  return (
    <div className="atop-page-shell">
      <PageHeader
        eyebrow="VARIABLE REGISTRY"
        title="公共变量池"
        subtitle="在测试集脚本中通过 ${变量名} 引用，触发时平台自动注入实际值"
        extra={
          <PermGuard resource="vars" action="create"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增变量</Button></PermGuard>
        }
      />

      <div className="atop-rule-card-grid">
        <div className="atop-rule-summary-card"><span>当前筛选</span><strong>{vars.length}</strong></div>
        <div className="atop-rule-summary-card"><span>系统级变量</span><strong>{systemCount}</strong></div>
        <div className="atop-rule-summary-card"><span>项目级变量</span><strong>{projectCount}</strong></div>
      </div>

      <Card
        className="atop-content-card atop-table-card"
        size="small"
        title={
          <SectionTitle
            icon={<KeyOutlined />}
            title="变量清单"
            note="系统级可全局复用，项目级仅在对应项目内生效"
            tone="warning"
          />
        }
        styles={{ body: { padding: '12px 0 0' } }}
      >
        <div className="atop-toolbar-card" style={{ margin: '0 12px 12px' }}>
          <KeyOutlined style={{ color: '#2563EB' }} />
          <Segmented
            value={scope}
            onChange={(v) => setScope(v as ScopeFilter)}
            options={[
              { label: '全部', value: 'all' },
              { label: '系统级', value: 'system' },
              { label: '项目级', value: 'project' },
            ]}
          />
          {scope !== 'all' && (
            <Button size="small" onClick={() => setScope('all')}>重置</Button>
          )}
        </div>

        {!isLoading && vars.length === 0 ? (
          <EmptyState description="暂无变量" createLabel="新增变量" onCreate={openCreate} resource="vars" />
        ) : (
          <Table
            {...tableProps}
            dataSource={vars}
            columns={cols}
            rowKey="id"
            size="small"
            loading={isLoading}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title={editing ? '编辑变量' : '新增变量'}
        open={modalOpen}
        onOk={() => handleSave(false)}
        onCancel={() => cancelWithConfirm(() => { setModalOpen(false); form.resetFields() })}
        maskClosable={false}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="key" label="变量名" rules={[
            { required: true },
            { pattern: /^[A-Z][A-Z0-9_]*$/, message: '仅支持大写字母、数字和下划线，且以字母开头' },
            maxLenRule('variableKey', '变量名'),
          ]}>
            <Input placeholder="例：IMAGE_REPO" disabled={!!editing} {...inputLimit('variableKey')} />
          </Form.Item>
          <Form.Item name="value" label="变量值" rules={[{ required: true }, maxLenRule('variableValue', '变量值')]}>
            <Input.TextArea rows={2} placeholder="变量的实际值" {...inputLimit('variableValue')} />
          </Form.Item>
          <Form.Item name="scope" label="作用域" rules={[{ required: true }]}>
            <Select options={[
              { label: '系统级（全部项目可用）', value: 'system' },
              { label: '项目级（仅指定项目）', value: 'project' },
            ]} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.scope !== cur.scope}
          >
            {({ getFieldValue }) => getFieldValue('scope') === 'project' && (
              <Form.Item name="projectId" label="所属项目" rules={[{ required: true }]}>
                <Select options={projectOptions} placeholder="选择项目" />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
