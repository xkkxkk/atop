import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import {
  Card, Table, Button, Space, Tag, Select, Input,
  message, Tooltip, Popconfirm, Checkbox,
} from 'antd'
import {
  PlusOutlined, UploadOutlined, EditOutlined, DeleteOutlined, CopyOutlined,
  PlayCircleOutlined, PauseCircleOutlined, CaretRightOutlined,
} from '@ant-design/icons'
import { testSetApi, type TestSetFilter } from '@/api/testsets'
import { useDimensions } from '@/hooks/useDimensions'
import { useTableLayout } from '@/hooks/useTableLayout'
import PageHeader from '@/components/common/PageHeader'
import { EnabledBadge, TaskStatusBadge } from '@/components/common/StatusBadge'
import EmptyState from '@/components/common/EmptyState'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import BatchImportModal from '@/components/testsets/BatchImportModal'
import { showConfirm } from '@/components/common/ConfirmModal'
import { PermGuard } from '@/hooks/usePermission'
import { useAudit } from '@/hooks/useAudit'
import type { TestSet } from '@/types'

export default function TestSetListPage() {
  const navigate   = useNavigate()
  const { trackClick } = useAudit()
  const { tableProps, defaultPageSize } = useTableLayout({ offsetY: 260 })
  const [filters, setFilters] = useState<TestSetFilter>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const { projectOptions, environmentOptions, productOptions } = useDimensions()

  const { data, isLoading, mutate } = useSWR(
    ['test-sets', page, pageSize, filters],
    () => testSetApi.list({ ...filters, page, pageSize }),
    { revalidateOnFocus: false }
  )

  const setFilter = (key: keyof TestSetFilter, value: unknown) => {
    setFilters((f) => ({ ...f, [key]: value || undefined }))
    setPage(1)
    setSelectedIds([])
  }

  // ── Toggle status ─────────────────────────────────────────────
  const handleToggleStatus = async (record: TestSet) => {
    const next = record.status === 'enabled' ? 'disabled' : 'enabled'
    try {
      await testSetApi.updateStatus(record.id, next)
      message.success(next === 'enabled' ? '已启用' : '已禁用')
      mutate()
    } catch { /* handled */ }
  }

  // ── Batch status ──────────────────────────────────────────────
  const handleBatchStatus = async (status: 'enabled' | 'disabled') => {
    if (!selectedIds.length) return
    showConfirm({
      title: `确认批量${status === 'enabled' ? '启用' : '禁用'} ${selectedIds.length} 个测试集？`,
      okDanger: status === 'disabled',
      okText: status === 'enabled' ? '启用' : '禁用',
      onOk: async () => {
        await testSetApi.batchUpdateStatus(selectedIds, status)
        message.success(`已${status === 'enabled' ? '启用' : '禁用'} ${selectedIds.length} 个测试集`)
        setSelectedIds([])
        mutate()
      },
    })
  }

  // ── Delete ────────────────────────────────────────────────────
  const handleDelete = (record: TestSet) => {
    showConfirm({
      title: `确认删除「${record.name}」？`,
      content: '删除后无法恢复，历史运行记录将保留但不可再次触发。',
      onOk: async () => {
        await testSetApi.delete(record.id)
        message.success('已删除')
        mutate()
      },
    })
  }

  // ── Single run ────────────────────────────────────────────────

  const handleClone = async (record: TestSet) => {
    try {
      const res = await testSetApi.clone(record.id)
      message.success(`已复制为「${(res as any).name}」，状态为禁用，请编辑后启用`)
      mutate()
    } catch { /* handled */ }
  }

  const handleRun = async (record: TestSet) => {
    try {
      await testSetApi.triggerSingle(record.id)
      message.success(`已触发「${record.name}」单独运行，稍后可在运行大盘查看结果`)
    } catch { /* handled */ }
  }

  const cols = [
    {
      title: () => (
        <Checkbox
          indeterminate={selectedIds.length > 0 && selectedIds.length < (data?.items.length ?? 0)}
          checked={selectedIds.length > 0 && selectedIds.length === data?.items.length}
          onChange={(e) => setSelectedIds(e.target.checked ? (data?.items.map((t) => t.id) ?? []) : [])}
        />
      ),
      key: 'check', width: 40,
      render: (_: unknown, row: TestSet) => (
        <Checkbox
          checked={selectedIds.includes(row.id)}
          onChange={(e) => setSelectedIds((prev) =>
            e.target.checked ? [...prev, row.id] : prev.filter((id) => id !== row.id)
          )}
        />
      ),
    },
    {
      title: '测试集名称', dataIndex: 'name', key: 'name',
      render: (name: string, row: TestSet) => (
        <a onClick={() => navigate(`/test-sets/${row.id}/edit`)} style={{ fontWeight: 500 }}>
          {name}
        </a>
      ),
    },
    {
      title: '三维坐标', key: 'coords',
      render: (_: unknown, row: TestSet) => (
        <Space size={3}>
          <Tag style={{ fontSize: 10, padding: '0 5px' }}>{row.project}</Tag>
          <Tag style={{ fontSize: 10, padding: '0 5px' }}>{row.environment}</Tag>
          <Tag style={{ fontSize: 10, padding: '0 5px' }}>{row.product}</Tag>
        </Space>
      ),
    },
    {
      title: '标签', dataIndex: 'tags', key: 'tags', width: 220,
      render: (tags: unknown) => {
        const list: string[] = Array.isArray(tags) ? tags : []
        if (list.length === 0) return <span style={{ color: '#ccc', fontSize: 11 }}>—</span>
        const visible = list.slice(0, 3)
        const hidden  = list.slice(3)
        return (
          <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 3, alignItems: 'center', overflow: 'hidden' }}>
            {visible.map((t) => (
              <Tag key={t} style={{ fontSize: 10, background: '#E6F1FB', color: '#185FA5', border: 'none', padding: '0 6px', margin: 0, flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={t}>
                {t}
              </Tag>
            ))}
            {hidden.length > 0 && (
              <Tooltip title={hidden.join('、')}>
                <Tag style={{ fontSize: 10, background: '#F5F5F4', color: '#9C9A92', border: 'none', padding: '0 6px', margin: 0, flexShrink: 0, cursor: 'default' }}>
                  +{hidden.length}
                </Tag>
              </Tooltip>
            )}
          </div>
        )
      },
    },
    {
      title: 'Agent', dataIndex: 'agentLabel', key: 'agent', width: 100,
      render: (l: string) => <code style={{ fontSize: 11, color: '#5F5E5A' }}>{l}</code>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 70,
      render: (s: TestSet['status']) => <EnabledBadge status={s} />,
    },
    {
      title: '最近运行', key: 'lastRun', width: 130,
      render: (_: unknown, row: TestSet) => (
        <Space size={4} direction="vertical" style={{ gap: 0 }}>
          {row.lastRunStatus && <TaskStatusBadge status={row.lastRunStatus as never} />}
          {row.lastRunAt && <RelativeTimeText value={row.lastRunAt} style={{ fontSize: 11, color: '#9C9A92' }} />}
        </Space>
      ),
    },
    {
      title: '操作', key: 'action', width: 160,
      render: (_: unknown, row: TestSet) => (
        <Space size={4}>
          <PermGuard resource="test_set" action="edit">
          <Tooltip title="编辑配置">
            <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/test-sets/${row.id}/edit`)} />
          </Tooltip>
          </PermGuard>
          <PermGuard resource="test_set" action="disable">
          <Tooltip title={row.status === 'enabled' ? '禁用' : '启用'}>
            <Button
              size="small"
              icon={row.status === 'enabled' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => handleToggleStatus(row)}
            />
          </Tooltip>
          </PermGuard>
          <PermGuard resource="test_set" action="clone">
          <Tooltip title="复制测试集">
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleClone(row)}
            />
          </Tooltip>
          </PermGuard>
          <PermGuard resource="test_set" action="trigger">
          <Tooltip title="单独运行">
            <Button
              size="small"
              icon={<CaretRightOutlined />}
              disabled={row.status !== 'enabled'}
              onClick={() => handleRun(row)}
            />
          </Tooltip>
          </PermGuard>
          <PermGuard resource="test_set" action="delete">
          <Tooltip title="删除">
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)} />
          </Tooltip>
          </PermGuard>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#EEEDE8' }}>
      <PageHeader
        title="测试集管理"
        extra={
          <Space>
            <PermGuard resource="test_set" action="import"><Button icon={<UploadOutlined />} onClick={() => { trackClick('批量导入测试集'); setImportOpen(true) }}>批量导入</Button></PermGuard>
            <PermGuard resource="test_set" action="create"><Button type="primary" icon={<PlusOutlined />} onClick={() => { trackClick('新建测试集'); navigate('/test-sets/new') }}>新建测试集</Button></PermGuard>
          </Space>
        }
      />

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select placeholder="项目" style={{ width: 160 }} allowClear options={projectOptions}
          value={filters.project} onChange={(v) => setFilter('project', v)} />
        <Select placeholder="环境" style={{ width: 110 }} allowClear options={environmentOptions}
          value={filters.environment} onChange={(v) => setFilter('environment', v)} />
        <Select placeholder="产品形态" style={{ width: 110 }} allowClear options={productOptions}
          value={filters.product} onChange={(v) => setFilter('product', v)} />
        <Select placeholder="状态" style={{ width: 100 }} allowClear
          options={[{ label: '已启用', value: 'enabled' }, { label: '已禁用', value: 'disabled' }]}
          value={filters.status} onChange={(v) => setFilter('status', v)} />
        <Input.Search
          placeholder="搜索名称..."
          style={{ width: 200 }}
          value={filters.keyword}
          onChange={(e) => setFilters(f => ({ ...f, keyword: e.target.value }))}
          onSearch={(v) => setFilter('keyword', v)}
          allowClear
        />
        <Button onClick={() => { setFilters({}); setPage(1); setSelectedIds([]) }}>重置</Button>

        {/* Batch actions */}
        {selectedIds.length > 0 && (
          <Space style={{ marginLeft: 'auto' }}>
            <span style={{ fontSize: 12, color: '#9C9A92' }}>已选 {selectedIds.length} 条</span>
            <Button size="small" onClick={() => handleBatchStatus('enabled')}>批量启用</Button>
            <Button size="small" danger onClick={() => handleBatchStatus('disabled')}>批量禁用</Button>
          </Space>
        )}
      </div>

      </div>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {!isLoading && data?.items.length === 0 ? (
          <EmptyState
            description="暂无测试集，点击右上角新建"
            createLabel="新建测试集"
            onCreate={() => navigate('/test-sets/new')}
          />
        ) : (
          <Table
            {...tableProps}
            dataSource={data?.items}
            columns={cols}
            rowKey="id"
            size="small"
            loading={isLoading}
            pagination={{
              ...tableProps.pagination,
              current: page,
              pageSize,
              total: data?.total ?? 0,
              onChange: (p, s) => { setPage(p); setPageSize(s) },
            }}
          />
        )}
      </Card>
      <BatchImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => { mutate(); setImportOpen(false) }}
      />
    </div>
  )
}
