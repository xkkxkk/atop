import { useState, useCallback } from 'react'
import useSWR from 'swr'
import {
  Card, Tabs, Table, Switch, Button, Space, Tag, message,
  Tooltip, Badge, Avatar, Select, Alert, Spin, Typography,
} from 'antd'
import {
  SaveOutlined, ReloadOutlined, UserOutlined,
  InfoCircleOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { PermGuard, usePermission, useReloadPermissions } from '@/hooks/usePermission'
import {
  permissionApi, RESOURCE_LABELS, ACTION_LABELS, ROLES, getRoleColor,
  type PermissionMap,
} from '@/api/permission'
import { userApi } from '@/api/admin'
import PageHeader from '@/components/common/PageHeader'
import type { UserRecord } from '@/types'

const { Text } = Typography

// ── Role colors ───────────────────────────────────────────────────────────
const ROLE_META = Object.fromEntries(ROLES.map(r => [r.value, r]))

function userInitial(name?: string): string {
  return name?.slice(0, 1)?.toUpperCase() || '?'
}

// ── Permission Matrix Editor ──────────────────────────────────────────────
interface MatrixEditorProps {
  perms:         PermissionMap
  onChange:      (p: PermissionMap) => void
  readonly?:     boolean
  disabledPerms?: PermissionMap  // 由角色控制的权限，置灰不可修改
  disabledTip?:  string          // 置灰时的 tooltip 提示
}

function PermissionMatrixEditor({
  perms,
  onChange,
  readonly = false,
  disabledPerms = {},
  disabledTip = '该权限由角色控制，如需修改请调整角色权限',
}: MatrixEditorProps) {
  const { data: matrix = [] } = useSWR('perm-matrix', permissionApi.getMatrix, {
    revalidateOnFocus: false,
  })

  const toggle = useCallback((resource: string, action: string, val: boolean) => {
    const next = {
      ...perms,
      [resource]: { ...(perms[resource] ?? {}), [action]: val },
    }
    onChange(next)
  }, [perms, onChange])

  const toggleAll = useCallback((resource: string, val: boolean) => {
    const actions = matrix.find(m => m.resource === resource)?.actions ?? []
    // 只修改未被角色控制的权限
    const next = { ...perms }
    if (!next[resource]) next[resource] = {}
    for (const a of actions) {
      const isRoleControlled = disabledPerms[resource]?.[a.action] === true
      if (!isRoleControlled) {
        next[resource][a.action] = val
      }
    }
    onChange(next)
  }, [perms, matrix, onChange, disabledPerms])

  if (!matrix.length) return <Spin style={{ display: 'block', padding: 40, textAlign: 'center' }} />

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#F8F9FA' }}>
            <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600,
              color: '#5F5E5A', borderBottom: '1px solid #f0f0f0', minWidth: 140 }}>
              资源模块
            </th>
            {/* Collect all unique actions */}
            {Array.from(new Set(matrix.flatMap(m => m.actions.map(a => a.action)))).map(act => (
              <th key={act} style={{ padding: '10px 12px', textAlign: 'center',
                fontWeight: 500, color: '#5F5E5A', borderBottom: '1px solid #f0f0f0',
                minWidth: 72, whiteSpace: 'nowrap' }}>
                {ACTION_LABELS[act] ?? act}
              </th>
            ))}
            <th style={{ padding: '10px 12px', textAlign: 'center',
              color: '#9C9A92', borderBottom: '1px solid #f0f0f0', minWidth: 80 }}>
              全选
            </th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((item, idx) => {
            const allActions = Array.from(new Set(matrix.flatMap(m => m.actions.map(a => a.action))))
            const hasAll = item.actions.every(a =>
              perms[item.resource]?.[a.action] === true
            )
            // 检查是否所有可编辑的权限都被角色控制了
            const allRoleControlled = item.actions.every(a =>
              disabledPerms[item.resource]?.[a.action] === true
            )
            return (
              <tr key={item.resource}
                style={{ background: idx % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                <td style={{ padding: '12px 16px', fontWeight: 500, color: '#1A1A18',
                  borderBottom: '1px solid #f5f5f5' }}>
                  <Space size={6}>
                    <span style={{ fontSize: 12, color: '#9C9A92',
                      background: '#F0F0F0', padding: '1px 6px', borderRadius: 4 }}>
                      {item.resource}
                    </span>
                    <span>{item.label}</span>
                  </Space>
                </td>
                {allActions.map(act => {
                  const supported = item.actions.some(a => a.action === act)
                  const allowed   = perms[item.resource]?.[act] === true
                  const isRoleControlled = disabledPerms[item.resource]?.[act] === true
                  const isDisabled = readonly || isRoleControlled
                  return (
                    <td key={act} style={{ padding: '12px', textAlign: 'center',
                      borderBottom: '1px solid #f5f5f5' }}>
                      {supported ? (
                        isRoleControlled ? (
                          <Tooltip title={disabledTip}>
                            <Switch
                              size="small"
                              checked={allowed}
                              disabled
                              checkedChildren="✓"
                              unCheckedChildren="✗"
                            />
                          </Tooltip>
                        ) : (
                          <Switch
                            size="small"
                            checked={allowed}
                            disabled={readonly}
                            onChange={val => toggle(item.resource, act, val)}
                            checkedChildren="✓"
                            unCheckedChildren="✗"
                          />
                        )
                      ) : (
                        <span style={{ color: '#e8e8e8', fontSize: 16 }}>—</span>
                      )}
                    </td>
                  )
                })}
                <td style={{ padding: '12px', textAlign: 'center',
                  borderBottom: '1px solid #f5f5f5' }}>
                  {!readonly && (
                    allRoleControlled ? (
                      <Tooltip title="所有权限均由角色控制">
                        <Switch
                          size="small"
                          checked={hasAll}
                          disabled
                          checkedChildren="全" unCheckedChildren="无"
                        />
                      </Tooltip>
                    ) : (
                      <Switch
                        size="small"
                        checked={hasAll}
                        onChange={val => toggleAll(item.resource, val)}
                        checkedChildren="全" unCheckedChildren="无"
                      />
                    )
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Role Permissions Tab ──────────────────────────────────────────────────
function RolePermissionsTab() {
  const [selectedRole, setSelectedRole] = useState('')
  const [dirty, setDirty]               = useState(false)
  const [saving, setSaving]             = useState(false)
  const [localPerms, setLocalPerms]     = useState<PermissionMap>({})
  const { can } = usePermission()
  const canEdit = can('permission', 'edit')
  const reloadPermissions = useReloadPermissions()

  // Dynamic roles list
  const { data: rolesList = [] } = useSWR('roles-list-perm', permissionApi.listRoles, {
    revalidateOnFocus: false,
    onSuccess: (data) => {
      // Auto-select first non-super_admin role
      if (!selectedRole && data.length > 0) {
        const first = data.find(r => r.name !== 'super_admin')
        if (first) setSelectedRole(first.name)
      }
    },
  })

  const { data: perms, isLoading, mutate } = useSWR(
    selectedRole ? ['role-perms', selectedRole] : null,
    () => permissionApi.getRolePermissions(selectedRole),
    {
      revalidateOnFocus: false,
      onSuccess: (data) => { setLocalPerms(data); setDirty(false) },
    }
  )

  const handleChange = (p: PermissionMap) => { setLocalPerms(p); setDirty(true) }

  const handleSave = async () => {
    setSaving(true)
    try {
      await permissionApi.updateRolePermissions(selectedRole, localPerms)
      message.success('权限已保存')
      await mutate()  // revalidate from server to confirm saved state
      setDirty(false)
      reloadPermissions()
    } catch { /* handled */ }
    finally { setSaving(false) }
  }

  const isSuperAdmin = selectedRole === 'super_admin'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Select
          placeholder="选择角色"
          value={selectedRole || undefined}
          onChange={(v) => { setSelectedRole(v); setDirty(false) }}
          style={{ width: 220 }}
          options={rolesList.map(r => ({
            value: r.name,
            label: r.displayName + (r.name === 'super_admin' ? ' (不可修改)' : ''),
            disabled: r.name === 'super_admin',
          }))}
        />
        <div style={{ flex: 1 }} />
        {dirty && (
          <Tag color="warning" icon={<InfoCircleOutlined />}>有未保存的修改</Tag>
        )}
        <Space>
          <PermGuard resource="permission" action="edit">
            <Button icon={<ReloadOutlined />} onClick={() => { mutate(); setDirty(false) }}>
              重置
            </Button>
          </PermGuard>
          <PermGuard resource="permission" action="edit"><Button type="primary" icon={<SaveOutlined />}
            loading={saving} disabled={!dirty} onClick={handleSave}>
            保存权限
          </Button></PermGuard>
        </Space>
      </div>

      {isSuperAdmin && (
        <Alert type="info" showIcon icon={<CheckCircleOutlined />}
          message="超级管理员拥有全部权限，不可修改"
          style={{ marginBottom: 12 }} />
      )}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {isLoading
          ? <Spin style={{ display: 'block', padding: 40, textAlign: 'center' }} />
          : (
            <PermissionMatrixEditor
              perms={localPerms}
              onChange={handleChange}
              readonly={selectedRole === 'super_admin' || !canEdit}
            />
          )
        }
      </Card>

      {selectedRole && !isSuperAdmin && (
        <div style={{ marginTop: 12, fontSize: 12, color: '#9C9A92' }}>
          提示：修改该角色的权限将影响所有该角色的用户，除非用户有单独的权限覆盖。
        </div>
      )}
    </div>
  )
}

// ── User Permission Overrides Tab ─────────────────────────────────────────
function UserPermissionsTab() {
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null)
  const [dirty, setDirty]               = useState(false)
  const [saving, setSaving]             = useState(false)
  const [localPerms, setLocalPerms]     = useState<PermissionMap>({})

  const { data: users = [] } = useSWR('users-for-perm',
    () => userApi.list({ page: 1, pageSize: 200 }).then(r => r.items),
    { revalidateOnFocus: false }
  )

  const { data: rolePerms } = useSWR(
    selectedUser ? ['role-perms-for-user', selectedUser.roles?.[0] ?? selectedUser.role] : null,
    () => permissionApi.getRolePermissions(selectedUser!.roles?.[0] ?? selectedUser!.role),
    { revalidateOnFocus: false }
  )

  const { data: overrides, isLoading, mutate } = useSWR(
    selectedUser ? ['user-perms', selectedUser.id] : null,
    () => permissionApi.getUserPermissionOverrides(selectedUser!.id),
    {
      revalidateOnFocus: false,
      onSuccess: (data) => { setLocalPerms(data); setDirty(false) },
    }
  )

  // Merge: effectivePerms = role perms + user overrides
  const effectivePerms: PermissionMap = {}
  if (rolePerms) {
    for (const [res, acts] of Object.entries(rolePerms)) {
      effectivePerms[res] = { ...acts }
    }
  }
  for (const [res, acts] of Object.entries(localPerms)) {
    if (!effectivePerms[res]) effectivePerms[res] = {}
    for (const [act, val] of Object.entries(acts)) {
      effectivePerms[res][act] = val
    }
  }

  // editPerms: what user sees and edits = effectivePerms (full merged view)
  // When user changes editPerms, compute diff vs rolePerms -> store as localPerms (overrides)
  // Note: 角色已开启的权限在 UI 上已禁用，这里再做一层过滤确保安全
  const handleEditChange = (edited: PermissionMap) => {
    // Compute diff: only store entries that differ from rolePerms
    // 并且跳过角色已开启的权限（这些不应该被用户覆盖）
    const diff: PermissionMap = {}
    for (const [res, acts] of Object.entries(edited)) {
      for (const [act, val] of Object.entries(acts)) {
        const roleVal = rolePerms?.[res]?.[act] ?? false
        // 如果角色已开启该权限，跳过（用户不能覆盖）
        if (roleVal === true) continue
        // 只存储与角色不同的值
        if (val !== roleVal) {
          if (!diff[res]) diff[res] = {}
          diff[res][act] = val
        }
      }
    }
    setLocalPerms(diff)
    setDirty(true)
  }

  const reloadPermissions2 = useReloadPermissions()

  const handleSave = async () => {
    if (!selectedUser) return
    setSaving(true)
    try {
      await permissionApi.updateUserPermissionOverrides(selectedUser.id, localPerms)
      message.success('用户权限已保存')
      await mutate()  // revalidate from server
      setDirty(false)
      reloadPermissions2()
    } catch { /* handled */ }
    finally { setSaving(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Select
          placeholder="选择用户"
          style={{ width: 280 }}
          value={selectedUser?.id}
          onChange={(id) => {
            const u = users.find(u => u.id === id) ?? null
            setSelectedUser(u)
            setLocalPerms({})
            setDirty(false)
          }}
          showSearch
          optionFilterProp="label"
          options={users.map(u => ({
            value: u.id,
            label: `${u.username} (${u.email})`,
            user: u,
          }))}
          optionRender={(opt) => {
            const u = (opt.data as any).user as UserRecord
            const rc = getRoleColor(u.roles?.[0] ?? u.role)
            const roleMeta = ROLE_META[u.roles?.[0] ?? u.role]
            return (
              <Space>
                <Avatar size={24} src={u.avatarUrl || undefined} style={{ background: rc.bg, color: rc.color,
                  fontSize: 11, fontWeight: 600 }}>
                  {!u.avatarUrl ? userInitial(u.username) : null}
                </Avatar>
                <div>
                  <div style={{ fontSize: 13 }}>{u.username}</div>
                  <div style={{ fontSize: 11, color: '#9C9A92' }}>
                    {u.email} · {roleMeta?.label ?? u.role}
                  </div>
                </div>
              </Space>
            )
          }}
        />
        {selectedUser && (
          <>
            <Tag color={getRoleColor(selectedUser.roles?.[0] ?? selectedUser.role).color} style={{ fontSize: 12 }}>
              {ROLE_META[selectedUser.roles?.[0] ?? selectedUser.role]?.label ?? selectedUser.roles?.[0] ?? selectedUser.role}
            </Tag>
            <div style={{ flex: 1 }} />
            {dirty && <Tag color="warning" icon={<InfoCircleOutlined />}>有未保存的修改</Tag>}
            <Space>
              <PermGuard resource="permission" action="edit">
                <Button icon={<ReloadOutlined />} onClick={() => { mutate(); setDirty(false) }}>
                  重置
                </Button>
              </PermGuard>
              <PermGuard resource="permission" action="edit">
                <Button type="primary" icon={<SaveOutlined />}
                  loading={saving} disabled={!dirty} onClick={handleSave}>
                  保存覆盖
                </Button>
              </PermGuard>
            </Space>
          </>
        )}
      </div>

      {!selectedUser && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#9C9A92' }}>
          <UserOutlined style={{ fontSize: 32, marginBottom: 12, display: 'block' }} />
          请先选择一个用户
        </div>
      )}

      {selectedUser && (
        <>
          <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
            message={
              <span>
                角色已开启的权限（置灰项）不可修改；角色未开启的权限可在此单独授权给该用户。
              </span>
            }
          />
          <Tabs
            size="small"
            items={[
              {
                key: 'override',
                label: '用户覆盖设置',
                children: isLoading
                  ? <Spin style={{ display: 'block', padding: 40, textAlign: 'center' }} />
                  : (
                    <Card size="small" styles={{ body: { padding: 0 } }}>
                      <PermissionMatrixEditor
                        perms={effectivePerms}
                        onChange={handleEditChange}
                        disabledPerms={rolePerms ?? {}}
                      />
                    </Card>
                  ),
              },
              {
                key: 'effective',
                label: '合并后有效权限',
                children: (
                  <Card size="small" styles={{ body: { padding: 0 } }}>
                    <PermissionMatrixEditor
                      perms={effectivePerms}
                      onChange={() => {}}
                      readonly
                    />
                  </Card>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function PermissionPage() {
  return (
    <div>
      <PageHeader
        title="权限管理"
        extra={
          <Tooltip title="权限立即生效，用户刷新页面后生效">
            <Text style={{ fontSize: 12, color: '#9C9A92' }}>
              <InfoCircleOutlined style={{ marginRight: 4 }} />
              修改后立即生效
            </Text>
          </Tooltip>
        }
      />

      <Alert
        type="warning" showIcon style={{ marginBottom: 16, fontSize: 13 }}
        message="权限说明"
        description={
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 2 }}>
            <li>超级管理员拥有全部权限，不受限制，不可修改</li>
            <li>角色权限是基础权限，适用于该角色的所有用户</li>
            <li>用户覆盖权限优先级高于角色权限，可额外授权或收回特定权限</li>
            <li>前端按钮的显示/禁用状态与权限同步，无权限操作会被服务端拦截</li>
          </ul>
        }
      />

      <Card size="small">
        <Tabs
          defaultActiveKey="role"
          items={[
            {
              key:      'role',
              label:    '角色权限配置',
              children: <RolePermissionsTab />,
            },
            {
              key:      'user',
              label:    '用户权限覆盖',
              children: <UserPermissionsTab />,
            },
          ]}
        />
      </Card>
    </div>
  )
}
