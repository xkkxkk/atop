import { useState, useEffect } from 'react'
import useSWR from 'swr'
import { Drawer, Button, Table, Select, message, Tag, Alert, Space, Segmented } from 'antd'
import { PlusOutlined, DeleteOutlined, CrownOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons'
import client from '@/api/client'
import { permissionApi, getRoleColor } from '@/api/permission'
import { usePermission } from '@/hooks/usePermission'

interface AccessEntry {
  type: 'user' | 'role'
  userId?: string
  userName?: string
  roleId?: string
  roleName?: string
  role: 'operator' | 'viewer'
}

interface AccessData {
  ownerId: string
  ownerName: string
  entries: AccessEntry[]
  currentRole: string
  canManage: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  pipelineId: string
  pipelineName: string
}

export default function PipelineAccessDrawer({ open, onClose, pipelineId, pipelineName }: Props) {
  const { can, isSuperAdmin } = usePermission()
  const [entries, setEntries] = useState<AccessEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [addMode, setAddMode] = useState<'user' | 'role'>('user')
  const [selectedUserId, setSelectedUserId] = useState<string>()
  const [selectedRoleId, setSelectedRoleId] = useState<string>()
  const [selectedPipelineRole, setSelectedPipelineRole] = useState<'operator' | 'viewer'>('operator')

  const { data, isLoading, mutate } = useSWR(
    open && pipelineId ? `pipeline-access-${pipelineId}` : null,
    () => client.get(`/pipelines/${pipelineId}/access`).then(r => r.data.data ?? r.data as AccessData),
  )

  const canLoadUserOptions = isSuperAdmin || can('users', 'view')
  const canLoadRoleOptions = isSuperAdmin || can('roles', 'view')
  const { data: users = [] } = useSWR(
    open && canLoadUserOptions ? 'all-users' : null,
    () => client.get('/admin/users', { params: { pageSize: 500 } }).then(r => {
      const list = r.data.data?.items ?? r.data.items ?? []
      return list
    }),
  )

  const { data: rolesList = [] } = useSWR(
    open && canLoadRoleOptions ? 'roles-list-access' : null,
    () => permissionApi.listRoles(),
    { revalidateOnFocus: false },
  )

  useEffect(() => {
    if (data?.entries) setEntries(data.entries.map((e: any) => ({ ...e, type: e.type || 'user' })))
  }, [data])

  const canManage = data?.canManage ?? false
  const ownerId = data?.ownerId ?? ''
  const assignedUserIds = new Set([ownerId, ...entries.filter(e => e.type === 'user').map(e => e.userId)])
  const assignedRoleIds = new Set(entries.filter(e => e.type === 'role').map(e => e.roleId))
  const availableUsers = (users as any[]).filter(u => !assignedUserIds.has(u.id))
  const availableRoles = rolesList.filter(r => r.name !== 'super_admin' && !assignedRoleIds.has(r.name))

  const handleAdd = () => {
    if (addMode === 'user') {
      if (!selectedUserId) { message.warning('请选择用户'); return }
      const user = (users as any[]).find(u => u.id === selectedUserId)
      setEntries([...entries, { type: 'user', userId: selectedUserId, userName: user?.username, role: selectedPipelineRole }])
      setSelectedUserId(undefined)
    } else {
      if (!selectedRoleId) { message.warning('请选择角色'); return }
      const role = rolesList.find(r => r.name === selectedRoleId)
      setEntries([...entries, { type: 'role', roleId: selectedRoleId, roleName: role?.displayName, role: selectedPipelineRole }])
      setSelectedRoleId(undefined)
    }
  }

  const handleRemove = (idx: number) => {
    setEntries(entries.filter((_, i) => i !== idx))
  }

  const handleRoleChange = (idx: number, role: 'operator' | 'viewer') => {
    setEntries(entries.map((e, i) => i === idx ? { ...e, role } : e))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await client.put(`/pipelines/${pipelineId}/access`, {
        entries: entries.map(e => {
          if (e.type === 'role') return { type: 'role', roleId: e.roleId, role: e.role }
          return { type: 'user', userId: e.userId, role: e.role }
        }),
      })
      message.success('权限已更新')
      mutate()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.message || '更新失败')
    } finally {
      setSaving(false)
    }
  }

  const cols = [
    {
      title: '类型', key: 'type', width: 70,
      render: (_: any, row: AccessEntry) => (
        <Tag color={row.type === 'role' ? 'purple' : 'default'} style={{ fontSize: 11 }}>
          {row.type === 'role' ? <><TeamOutlined /> 角色</> : <><UserOutlined /> 用户</>}
        </Tag>
      ),
    },
    {
      title: '名称', key: 'name',
      render: (_: any, row: AccessEntry) => {
        if (row.type === 'role') {
          const c = getRoleColor(row.roleId || '')
          return (
            <Tag style={{ color: c.color, background: c.bg, border: 'none', fontWeight: 500 }}>
              {row.roleName || row.roleId}
            </Tag>
          )
        }
        return row.userName || row.userId
      },
    },
    {
      title: '流水线角色', key: 'role', width: 180,
      render: (_: any, row: AccessEntry, idx: number) => (
        <Select
          size="small"
          value={row.role}
          disabled={!canManage}
          style={{ width: 160 }}
          onChange={(v) => handleRoleChange(idx, v)}
          options={[
            { label: '触发者 (operator)', value: 'operator' },
            { label: '查看者 (viewer)', value: 'viewer' },
          ]}
        />
      ),
    },
    {
      title: '', key: 'action', width: 50,
      render: (_: any, __: AccessEntry, idx: number) => canManage ? (
        <Button size="small" type="text" danger icon={<DeleteOutlined />}
          onClick={() => handleRemove(idx)} />
      ) : null,
    },
  ]

  return (
    <Drawer
      title={
        <div>
          <div className="atop-drawer-eyebrow">PIPELINE ACCESS</div>
          <div className="atop-drawer-title">流水线权限 · {pipelineName}</div>
        </div>
      }
      open={open}
      onClose={onClose}
      width={620}
      extra={canManage ? (
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
        </Space>
      ) : null}
    >
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
      ) : (
        <>
          <Alert
            message={
              <div>
                <div style={{ marginBottom: 4 }}>
                  <CrownOutlined style={{ color: '#FAAD14', marginRight: 6 }} />
                  <strong>创建人：{data?.ownerName || ownerId}</strong>
                  <Tag color="gold" style={{ marginLeft: 8, fontSize: 11 }}>owner</Tag>
                </div>
                <div style={{ fontSize: 12, color: '#5F5E5A' }}>
                  创建人拥有所有权限（编辑/触发/删除/权限管理）。可按用户或按角色分配权限。
                </div>
              </div>
            }
            type="info"
            style={{ marginBottom: 16 }}
          />

          {!canManage && (
            <Alert
              message="您没有权限管理此流水线的访问控制"
              description={`当前角色：${data?.currentRole || '无'}`}
              type="warning"
              style={{ marginBottom: 16 }}
            />
          )}

          <div className="atop-panel-title" style={{ marginBottom: 8 }}>角色说明</div>
          <div className="atop-access-role-grid">
            <div><Tag color="gold" style={{ fontSize: 10 }}>owner</Tag> 全权控制（编辑/触发/删除/权限）</div>
            <div><Tag color="blue" style={{ fontSize: 10 }}>operator</Tag> 可触发运行，不可编辑</div>
            <div><Tag color="default" style={{ fontSize: 10 }}>viewer</Tag> 仅查看运行记录</div>
          </div>

          {canManage && (
            <div className="atop-access-add-panel">
              <div style={{ marginBottom: 8 }}>
                <Segmented
                  size="small"
                  value={addMode}
                  onChange={(v) => setAddMode(v as 'user' | 'role')}
                  options={[
                    { label: '按用户分配', value: 'user', icon: <UserOutlined /> },
                    { label: '按角色分配', value: 'role', icon: <TeamOutlined /> },
                  ]}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {addMode === 'user' ? (
                  <Select
                    placeholder="选择用户"
                    value={selectedUserId}
                    onChange={setSelectedUserId}
                    style={{ flex: 1 }}
                    showSearch
                    optionFilterProp="label"
                    options={availableUsers.map((u: any) => ({
                      label: `${u.username} (${u.email})`,
                      value: u.id,
                    }))}
                  />
                ) : (
                  <Select
                    placeholder="选择角色"
                    value={selectedRoleId}
                    onChange={setSelectedRoleId}
                    style={{ flex: 1 }}
                    options={availableRoles.map(r => ({
                      label: r.displayName,
                      value: r.name,
                    }))}
                  />
                )}
                <Select
                  value={selectedPipelineRole}
                  onChange={setSelectedPipelineRole}
                  style={{ width: 160 }}
                  options={[
                    { label: 'operator', value: 'operator' },
                    { label: 'viewer', value: 'viewer' },
                  ]}
                />
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
              </div>
            </div>
          )}

          <Table
            size="small"
            dataSource={entries}
            columns={cols}
            rowKey={(_, idx) => String(idx)}
            pagination={false}
            locale={{ emptyText: '未分配任何用户或角色，仅创建人可访问' }}
          />
        </>
      )}
    </Drawer>
  )
}
