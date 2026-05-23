import { useState } from 'react'
import useSWR from 'swr'
import { Card, Table, Button, Form, Input, Modal, message, Space, Popconfirm, Tabs, Tag, Badge } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { dimensionApi } from '@/api/settings'
import { useModalForm } from '@/hooks/useModalForm'
import PageHeader from '@/components/common/PageHeader'
import { PermGuard } from '@/hooks/usePermission'
import EmptyState from '@/components/common/EmptyState'
import type { DimensionItem, DimensionType } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

// Five dimensions
const DIMENSION_META: Record<string, { label: string; color: string; bg: string; desc: string }> = {
  project:     { label: '项目',    color: '#185FA5', bg: '#E6F1FB', desc: '测试集所属的项目标识，如 V3_SOFTWARE_master' },
  environment: { label: '环境',    color: '#085041', bg: '#E1F5EE', desc: '运行环境，如 EMU、CMODEL、FPGA' },
  product:     { label: '产品形态', color: '#633806', bg: '#FAEEDA', desc: '产品形态，如 CMODEL、ASIC、FPGA' },
  os:          { label: '系统(OS)', color: '#5F5E5A', bg: '#F5F5F4', desc: '操作系统，如 Windows、Linux、macOS' },
  run_type:    { label: '类型',    color: '#3C3489', bg: '#EEEDFE', desc: '运行类型，如 daily、nightly、regression、smoke' },
}

const ALL_DIMS = Object.keys(DIMENSION_META) as DimensionType[]

function DimTab({ dimension, items, loading, onMutate }: {
  dimension: DimensionType
  items: DimensionItem[]
  loading: boolean
  onMutate: () => void
}) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<DimensionItem | null>(null)
  const [form] = Form.useForm()
  const { cancelWithConfirm, markClean } = useModalForm(form)
  const meta = DIMENSION_META[dimension] ?? { label: dimension, color: '#5F5E5A', bg: '#F5F5F4', desc: '' }

  const openCreate = () => { setEditing(null); form.resetFields(); markClean({}); setModalOpen(true) }
  const openEdit = (r: DimensionItem) => {
    const initial = { value: r.value, displayName: r.displayName, sortOrder: r.sortOrder }
    setEditing(r)
    form.setFieldsValue(initial)
    markClean(initial)
    setModalOpen(true)
  }

  const handleSave = async () => {
    try {
      const vals = await form.validateFields()
      editing
        ? await dimensionApi.update(editing.id, vals)
        : await dimensionApi.create({ ...vals, dimension, sortOrder: items.length + 1 })
      message.success(editing ? '已保存' : '已添加')
      setModalOpen(false)
      onMutate()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败')
    }
  }

  const handleDel = async (id: string) => {
    try {
      await dimensionApi.delete(id)
      message.success('已删除')
      onMutate()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '删除失败')
    }
  }

  const cols = [
    {
      title: '值', dataIndex: 'value', key: 'value',
      render: (v: string) => (
        <Tag style={{ background: meta.bg, color: meta.color, border: 'none', fontFamily: 'monospace', fontSize: 13 }}>
          {v}
        </Tag>
      ),
    },
    {
      title: '显示名称', dataIndex: 'displayName', key: 'displayName',
      render: (n: string) => <span style={{ fontSize: 13, color: '#5F5E5A' }}>{n || '—'}</span>,
    },
    { title: '排序', dataIndex: 'sortOrder', key: 'sort', width: 60,
      render: (n: number) => <span style={{ color: '#9C9A92' }}>{n}</span> },
    {
      title: '操作', key: 'action', width: 100,
      render: (_: unknown, row: DimensionItem) => (
        <Space size={4} className="atop-action-row">
          <PermGuard resource="dimensions" action="edit"><Button className="atop-icon-mini" size="small" aria-label="编辑字典项" icon={<EditOutlined />} onClick={() => openEdit(row)} /></PermGuard>
          <PermGuard resource="dimensions" action="delete"><Popconfirm
            title="确认删除？"
            description="请确认当前无测试集使用此值"
            onConfirm={() => handleDel(row.id)}
            okButtonProps={{ danger: true }}
            okText="删除"
          >
            <Button className="atop-icon-mini" size="small" danger aria-label="删除字典项" icon={<DeleteOutlined />} />
          </Popconfirm></PermGuard>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className="atop-dimension-banner" style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
        padding: '10px 16px', background: meta.bg, borderColor: `${meta.color}24`,
      }}>
        <div style={{ flex: 1 }}>
          <div className="atop-dimension-title" style={{ color: meta.color }}>{meta.label}</div>
          <div className="atop-dimension-desc" style={{ color: meta.color }}>{meta.desc}</div>
        </div>
        <Badge count={items.length} style={{ background: meta.color }} title={`当前 ${meta.label} 条目数`} />
        <PermGuard resource="dimensions" action="create"><Button type="primary" ghost size="small" icon={<PlusOutlined />} onClick={openCreate}>
          新增
        </Button></PermGuard>
      </div>

      {items.length === 0 && !loading
        ? <EmptyState description="暂无数据" createLabel="新增" onCreate={openCreate} resource="dimensions" />
        : <Table dataSource={items} columns={cols} rowKey="id" size="small"
            loading={loading} pagination={false}
            footer={() => <span style={{ fontSize: 12, color: '#9C9A92' }}>共 {items.length} 条</span>}
          />
      }

      <Modal
        title={editing ? `编辑「${meta.label}」条目` : `新增「${meta.label}」条目`}
        open={modalOpen} onOk={handleSave} onCancel={() => cancelWithConfirm(() => { setModalOpen(false); form.resetFields() })}
        maskClosable={false}
        okText="保存" cancelText="取消" destroyOnClose width={400}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="value" label="唯一标识值" rules={[
            { required: true },
            { pattern: /^[A-Za-z0-9_]+$/, message: '仅字母、数字、下划线' },
            maxLenRule('dimensionValue', '唯一标识值'),
          ]} extra="测试集配置中使用的实际值，创建后不可修改">
            <Input placeholder={`如：${dimension === 'run_type' ? 'nightly' : dimension === 'environment' ? 'EMU' : 'example'}`} disabled={!!editing} {...inputLimit('dimensionValue')} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称" rules={[maxLenRule('dimensionDisplayName', '显示名称')]} extra="界面展示用，可不填">
            <Input placeholder="可选" {...inputLimit('dimensionDisplayName')} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序序号">
            <Input type="number" placeholder="数字越小越靠前" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default function DimensionsPage() {
  const { data = [], isLoading, mutate } = useSWR(
    'dimension-dict-all', () => dimensionApi.list(), { revalidateOnFocus: false }
  )

  const byDim = (dim: DimensionType) =>
    data.filter((d) => d.dimension === dim).sort((a, b) => a.sortOrder - b.sortOrder)

  const tabItems = ALL_DIMS.map((dim) => {
    const meta = DIMENSION_META[dim]
    const count = byDim(dim).length
    return {
      key: dim,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {meta.label}
          <Badge count={count} size="small" style={{ background: count > 0 ? meta.color : '#D3D1C7' }} />
        </span>
      ),
      children: (
        <DimTab dimension={dim as DimensionType} items={byDim(dim as DimensionType)} loading={isLoading} onMutate={mutate} />
      ),
    }
  })

  return (
    <div className="atop-page-shell">
      <PageHeader
        eyebrow="DIMENSION DICTIONARY"
        title="数据字典管理"
        subtitle="管理流水线创建与筛选所需的五个维度枚举值，修改后立即生效"
      />
      <Card size="small" className="atop-content-card atop-table-card atop-dimension-tabs">
        <Tabs items={tabItems} size="middle" tabBarStyle={{ marginBottom: 16 }} />
      </Card>
    </div>
  )
}
