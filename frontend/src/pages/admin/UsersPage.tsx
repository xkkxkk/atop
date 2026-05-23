import { useState, useCallback, useMemo, useEffect, Fragment } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  Card, Button, Space, Tag, message, Modal, Form, Input, Select,
  Switch, Spin, Badge, Tabs, Empty, Popconfirm,
  Pagination, Timeline, Upload, Dropdown,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, EditOutlined, SearchOutlined,
  SaveOutlined, InfoCircleOutlined, TeamOutlined,
  HistoryOutlined, KeyOutlined, SafetyOutlined, DeleteOutlined, ImportOutlined, DownloadOutlined,
  StopOutlined, PlayCircleOutlined,
  WarningOutlined, UserOutlined,
} from '@ant-design/icons'
import { userApi } from '@/api/admin'
import { permissionApi, getRoleColor, type PermissionMap, type RoleLite } from '@/api/permission'
import { PermGuard, usePermission, useReloadPermissions } from '@/hooks/usePermission'
import { useAuthStore } from '@/store/auth'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import type { UserRecord } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

// ── Time formatter ─────────────────────────────────────────────────────────
function fmtTime(s: string | undefined | null): string {
  if (!s) return '—'
  try {
    const d = new Date(s)
    if (isNaN(d.getTime())) return s
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0')
  } catch { return s }
}

function userInitial(name?: string): string {
  const first = name?.trim()?.charAt(0)
  return first ? first.toUpperCase() : ''
}

function cleanAvatarUrl(url?: string): string {
  const value = url?.trim()
  if (!value || value === 'null' || value === 'undefined') return ''
  if (value.startsWith('data:image/') || value.startsWith('http://') || value.startsWith('https://')) return value
  return ''
}

function avatarTone(roleName?: string) {
  return roleName ? getRoleColor(roleName) : { bg: '#E6F1FB', color: '#185FA5' }
}

function UserAvatar({ user, size = 36, roleName }: {
  user: Pick<UserRecord, 'username' | 'email' | 'avatarUrl'>
  size?: number
  roleName?: string
}) {
  const avatarUrl = cleanAvatarUrl(user.avatarUrl)
  const initial = userInitial(user.username) || userInitial(user.email) || 'A'
  const tone = avatarTone(roleName)

  return (
    <span
      className="atop-user-avatar"
      style={{
        width: size,
        height: size,
        minWidth: size,
        background: tone.bg,
        color: tone.color,
        fontSize: Math.max(13, Math.round(size * 0.38)),
      }}
      aria-label={`${user.username || user.email || '用户'}头像`}
    >
      {initial ? (
        <span>{initial}</span>
      ) : (
        <UserOutlined />
      )}
      {avatarUrl && <img src={avatarUrl} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
    </span>
  )
}

// ── Color palette for user avatar ──────────────────────────────────────────
const COLOR_PALETTE = [
  { bg: '#1A1A18', color: '#fff' },
  { bg: '#185FA5', color: '#fff' },
  { bg: '#6A3DB5', color: '#fff' },
  { bg: '#AD3B76', color: '#fff' },
  { bg: '#E6F1FB', color: '#185FA5' },
  { bg: '#F0E6FB', color: '#6A3DB5' },
  { bg: '#FBE6F0', color: '#AD3B76' },
  { bg: '#E8F5E9', color: '#2E7D32' },
  { bg: '#FFF3E0', color: '#E65100' },
  { bg: '#FCE4EC', color: '#C62828' },
]

const SYSTEM_ADMIN_EMAIL = 'admin@atop.local'

// ── Category map for grouping ──────────────────────────────────────────────
const CAT_MAP: Record<string, string> = {
  pipeline: '任务流转', jenkins: '任务流转',
  vars: '资源配置', dimensions: '资源配置',
  users: '系统管理', roles: '系统管理', permission: '系统管理', audit: '系统管理',
  cleanup: '系统管理', notification_rule: '系统管理',
}

const ACT_LABELS: Record<string, string> = {
  view: '查看', create: '新建', edit: '编辑', delete: '删除', trigger: '触发',
  import: '导入', clone: '复制', ping: '连通', sync: '同步', reset_pwd: '重置密码',
  disable: '禁用', fullscreen: '全屏',
}

// ── Permission Matrix ─────────────────────────────────────────────────────
function UserPermMatrix({ perms, onChange, readonly = false, rolePerms }: {
  perms: PermissionMap
  onChange: (p: PermissionMap) => void
  readonly?: boolean
  rolePerms?: PermissionMap
}) {
  const { data: matrix = [] } = useSWR('perm-matrix-user', permissionApi.getMatrix, { revalidateOnFocus: false })

  const toggle = useCallback((resource: string, action: string, val: boolean) => {
    onChange({ ...perms, [resource]: { ...(perms[resource] ?? {}), [action]: val } })
  }, [perms, onChange])

  if (!matrix.length) return <Spin style={{ display: 'block', padding: 40, textAlign: 'center' }} />

  const allActions = Array.from(new Set(matrix.flatMap(m => m.actions.map(a => a.action))))

  // Group by category
  const groups: Record<string, typeof matrix> = {}
  for (const item of matrix) {
    const cat = CAT_MAP[item.resource] ?? '其他'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(item)
  }

  // Compute stats: total perms = role + user combined
  const totalPerms = matrix.reduce((s, m) => s + m.actions.length, 0)
  const enabledPerms = matrix.reduce((s, m) =>
    s + m.actions.filter(a =>
      rolePerms?.[m.resource]?.[a.action] === true || perms[m.resource]?.[a.action] === true
    ).length, 0)

  return (
    <div>
      <div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 8 }}>
        已授权 <b style={{ color: '#1677ff' }}>{enabledPerms}</b> / {totalPerms}{' '}
        覆盖率 <b style={{ color: '#1677ff' }}>{totalPerms > 0 ? Math.round(enabledPerms / totalPerms * 100) : 0}%</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#FAFAFA' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#5F5E5A',
                borderBottom: '2px solid #f0f0f0', minWidth: 130, position: 'sticky', left: 0, background: '#FAFAFA', zIndex: 1 }}>资源</th>
              {allActions.map(a => (
                <th key={a} style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 500,
                  color: '#8C8C8C', borderBottom: '2px solid #f0f0f0', minWidth: 56, fontSize: 12 }}>
                  {ACT_LABELS[a] ?? a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(groups).map(([cat, items]) => (
              <Fragment key={`g-${cat}`}>
                <tr><td colSpan={allActions.length + 1} style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600, color: '#8C8C8C', background: '#F5F5F4', borderBottom: '1px solid #eee', textAlign: 'right' }}>{cat} · {items.length} 项资源</td></tr>
                {items.map((item, idx) => (
                  <tr key={item.resource} style={{ background: idx % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 500, color: '#1A1A18',
                      borderBottom: '1px solid #f5f5f5', position: 'sticky', left: 0,
                      background: idx % 2 === 0 ? '#fff' : '#FAFBFC', zIndex: 1 }}>
                      <span style={{ fontSize: 11, color: '#9C9A92', background: '#F0F0F0',
                        padding: '1px 5px', borderRadius: 3, marginRight: 6, fontFamily: 'monospace' }}>
                        {item.resource}
                      </span>
                      {item.label}
                    </td>
                    {allActions.map(act => {
                      const supported = item.actions.some(a => a.action === act)
                      const fromRole = rolePerms?.[item.resource]?.[act] === true
                      const fromUser = perms[item.resource]?.[act] === true
                      const checked = fromRole || fromUser
                      return (
                        <td key={act} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid #f5f5f5' }}>
                          {supported ? (
                            <Switch size="small" checked={checked}
                              disabled={readonly || fromRole}
                              onChange={v => toggle(item.resource, act, v)}
                              checkedChildren="✓" unCheckedChildren="✗"
                              style={fromRole ? { opacity: 0.5 } : undefined}
                            />
                          ) : <span style={{ color: '#e8e8e8' }}>—</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────
const PAGE_SIZE = 12

export default function UsersPage() {
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [listPage, setListPage] = useState(1)
  const [activeTab, setActiveTab] = useState('roles')
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [permDirty, setPermDirty] = useState(false)
  const [permSaving, setPermSaving] = useState(false)
  const [localPerms, setLocalPerms] = useState<PermissionMap>({})
  const [createForm] = Form.useForm()
  const [createColor, setCreateColor] = useState(0)
  const [importing, setImporting] = useState(false)
  const [editForm] = Form.useForm()
  const { can } = usePermission()
  const reloadPermissions = useReloadPermissions()
  const currentUser = useAuthStore((s) => s.user)

  // Fetch users
  const { data: usersData, isLoading, mutate } = useSWR(
    ['admin-users', listPage, search, statusFilter],
    () => userApi.list({
      page: listPage, pageSize: PAGE_SIZE,
      keyword: search || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
    }),
  )
  const users = usersData?.items ?? []
  const totalUsers = usersData?.total ?? 0

  // Dynamic roles list
  const { data: rolesList = [], mutate: mutateRolesList } = useSWR('roles-list-users', permissionApi.listRoles)
  const roleMap = useMemo(() => {
    const m: Record<string, RoleLite> = {}
    for (const r of rolesList) m[r.name] = r
    return m
  }, [rolesList])

  // Selected user
  const selectedUser = users.find((u: UserRecord) => u.id === selectedId)
  const isSystemAdmin = selectedUser?.email === SYSTEM_ADMIN_EMAIL
  const isSelf = !!selectedUser && selectedUser.id === currentUser?.id

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE))
    if (listPage > maxPage) {
      setListPage(maxPage)
    }
  }, [listPage, totalUsers])

  useEffect(() => {
    if (users.length === 0) {
      if (selectedId) {
        setSelectedId('')
      }
      return
    }

    const hasSelected = users.some((user) => user.id === selectedId)
    if (!hasSelected) {
      setSelectedId(users[0].id)
      setPermDirty(false)
      setActiveTab('roles')
    }
  }, [users, selectedId])

  // Get user roles
  const userRoles = selectedUser?.roles?.length ? selectedUser.roles : (selectedUser?.role ? [selectedUser.role] : [])

  // Tab data: fetch on tab switch
  const { data: userRolePerms = {}, mutate: mutateRolePerms } = useSWR(
    selectedUser ? ['user-role-perms-merge', selectedUser.id] : null,
    async () => {
      const merged: PermissionMap = {}
      for (const r of userRoles) {
        // Skip disabled roles
        const roleMeta = roleMap[r]
        if (roleMeta?.status === 'disabled') continue
        try {
          const rp = await permissionApi.getRolePermissions(r)
          for (const [res, acts] of Object.entries(rp)) {
            if (!merged[res]) merged[res] = {}
            for (const [act, val] of Object.entries(acts)) {
              if (val) merged[res][act] = true
            }
          }
        } catch { /* skip */ }
      }
      return merged
    },
    { revalidateOnFocus: false }
  )

  const { data: userOverridesData, mutate: mutateOverrides } = useSWR(
    selectedUser ? ['user-overrides', selectedUser.id] : null,
    () => permissionApi.getUserPermissionOverrides(selectedUser!.id),
    { revalidateOnFocus: false, onSuccess: (d: PermissionMap) => { setLocalPerms(d); setPermDirty(false) } }
  )

  // Count total effective permissions (role + user overrides combined)
  const { data: permMatrix = [] } = useSWR('perm-matrix-count', permissionApi.getMatrix, { revalidateOnFocus: false })
  const totalUserPerms = useMemo(() => {
    let count = 0
    for (const m of permMatrix) {
      for (const a of m.actions) {
        const fromRole = userRolePerms?.[m.resource]?.[a.action] === true
        const fromUser = (userOverridesData ?? localPerms)?.[m.resource]?.[a.action] === true
        if (fromRole || fromUser) count++
      }
    }
    return count
  }, [permMatrix, userRolePerms, userOverridesData, localPerms])

  const { data: userHistory = [], mutate: mutateHistory } = useSWR(
    selectedUser && activeTab === 'history' ? ['user-history', selectedUser.id] : null,
    () => userApi.getHistory(selectedUser!.id),
    { revalidateOnFocus: false }
  )

  // Tab change: force refetch
  const handleTabChange = (key: string) => {
    setActiveTab(key)
    if (!selectedUser) return
    mutateRolesList() // always refresh roles status
    if (key === 'roles') { mutate() }
    if (key === 'perms') { mutateRolePerms(undefined, { revalidate: true }); mutateOverrides(undefined, { revalidate: true }) }
    if (key === 'history') { mutateHistory(undefined, { revalidate: true }) }
  }

  // Handlers
  const handlePermChange = (p: PermissionMap) => {
    const diff: PermissionMap = {}
    for (const [res, acts] of Object.entries(p)) {
      for (const [act, val] of Object.entries(acts)) {
        if (userRolePerms?.[res]?.[act] === true) continue
        if (val) { if (!diff[res]) diff[res] = {}; diff[res][act] = true }
      }
    }
    setLocalPerms(diff)
    setPermDirty(true)
  }

  const handlePermSave = async () => {
    if (!selectedUser) return
    setPermSaving(true)
    try {
      await permissionApi.updateUserPermissionOverrides(selectedUser.id, localPerms)
      message.success('用户权限已保存')
      mutateOverrides(); setPermDirty(false); reloadPermissions()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败')
    }
    finally { setPermSaving(false) }
  }

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      const created = await userApi.create(values)
      Modal.success({ title: '用户创建成功', content: '系统已设置初始密码：#PassW0rd，用户下次登录需修改密码。' })
      setCreateOpen(false)
      createForm.resetFields()
      setListPage(1)
      setSelectedId(created.id)
      setActiveTab('roles')
      mutate(undefined, { revalidate: true })
      globalMutate('nav-users-count')
    } catch (e: any) { if (e?.response?.data?.message) message.error(e.response.data.message) }
  }

  const handleEdit = async () => {
    if (!selectedUser) return
    try {
      const values = await editForm.validateFields()
      await userApi.update(selectedUser.id, values)
      message.success('保存成功'); setEditOpen(false); mutate()
    } catch (e: any) { if (e?.response?.data?.message) message.error(e.response.data.message) }
  }

  const handleToggleStatus = async () => {
    if (!selectedUser) return
    const newStatus = selectedUser.status === 'active' ? 'disabled' : 'active'
    try {
      await userApi.updateStatus(selectedUser.id, newStatus)
      message.success(newStatus === 'active' ? '已启用' : '已停用')
      mutate(); globalMutate('nav-users-count')
    } catch (e: any) { message.error(e?.response?.data?.message || '操作失败') }
  }

  const handleResetPassword = async () => {
    if (!selectedUser) return
    try {
      const res = await userApi.resetPassword(selectedUser.id)
      Modal.success({
        title: '密码已重置',
        content: (
          <div>
            <div style={{ marginBottom: 8 }}>系统已生成一次性临时密码，24 小时内有效，用户下次登录后必须修改。</div>
            {res.tempPassword ? (
              <Input.Password value={res.tempPassword} readOnly visibilityToggle style={{ fontFamily: 'monospace' }} />
            ) : (
              <div style={{ color: '#faad14' }}>临时密码未返回，请让用户查看邮件或重新重置。</div>
            )}
            {res.expiresAt && (
              <div style={{ marginTop: 8, color: '#AD6800', fontSize: 12 }}>
                过期时间：{fmtTime(res.expiresAt)}
              </div>
            )}
            <div style={{ marginTop: 8, color: '#8C8C8C', fontSize: 12 }}>
              {res.emailSent ? '已尝试发送到用户邮箱。' : '当前未发送邮件，请复制临时密码交给用户。'}
            </div>
          </div>
        ),
      })
    } catch (e: any) { message.error(e?.response?.data?.message || '重置失败') }
  }

  const handleBatchImport = async (file: File) => {
    setImporting(true)
    try {
      const res = await userApi.batchImport(file)
      const count = res?.data?.success ?? res?.data?.imported ?? res?.data?.count ?? 0
      message.success(`成功导入 ${count} 个用户，初始密码统一为 #PassW0rd`)
      mutate(); globalMutate('nav-users-count')
    } catch (e: any) { message.error(e?.response?.data?.message || '导入失败') }
    finally { setImporting(false) }
    return false
  }

  const downloadUserTemplate = () => {
    const rows = [
      ['username', 'email', 'roles', 'projects', 'status'],
      ['张三', 'zhangsan@example.com', 'member', 'default', 'active'],
      ['李四', 'lisi@example.com', 'viewer;member', 'default;mobile', 'active'],
      ['说明：密码不用填写，系统统一初始化为 #PassW0rd；roles 可填 super_admin/project_manager/member/viewer，多个用 ; 分隔；projects 按系统已有项目编码填写，多个用 ; 分隔；status 下拉值为 active/disabled。', '', '', '', ''],
    ]
    const csv = rows
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'ATOP_用户批量导入模板.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    message.success('用户导入模板已下载')
  }

  const handleDeleteUser = async () => {
    if (!selectedUser) return
    try {
      await userApi.delete(selectedUser.id)
      message.success('用户已删除')
      setSelectedId(''); mutate(); globalMutate('nav-users-count')
    } catch (e: any) { message.error(e?.response?.data?.message || '删除失败') }
  }

  const selectUserForDetail = (user: UserRecord, tab = 'roles') => {
    setSelectedId(user.id)
    setPermDirty(false)
    setActiveTab(tab)
    mutateRolesList()
  }

  const openEditUser = (user: UserRecord) => {
    selectUserForDetail(user)
    setEditOpen(true)
    const roles = user.roles?.length ? user.roles : (user.role ? [user.role] : [])
    editForm.setFieldsValue({
      username: user.username,
      roles,
      projects: user.projects ?? [],
    })
  }

  const resetPasswordForUser = async (user: UserRecord) => {
    selectUserForDetail(user)
    try {
      const res = await userApi.resetPassword(user.id)
      Modal.success({
        title: '密码已重置',
        content: res.tempPassword ? <Input.Password value={res.tempPassword} readOnly visibilityToggle style={{ fontFamily: 'monospace' }} /> : '临时密码未返回，请让用户查看邮件或重新重置。',
      })
    } catch (e: any) { message.error(e?.response?.data?.message || '重置失败') }
  }

  const toggleStatusForUser = (user: UserRecord) => {
    const newStatus = user.status === 'active' ? 'disabled' : 'active'
    Modal.confirm({
      title: newStatus === 'active' ? '确认启用该用户？' : '确认停用该用户？',
      content: newStatus === 'active' ? '启用后用户可正常登录。' : '停用后用户将无法登录。',
      okText: newStatus === 'active' ? '启用' : '停用',
      okButtonProps: { danger: newStatus === 'disabled' },
      onOk: async () => {
        await userApi.updateStatus(user.id, newStatus)
        message.success(newStatus === 'active' ? '已启用' : '已停用')
        mutate(); globalMutate('nav-users-count')
      },
    })
  }

  const deleteUserDirectly = (user: UserRecord) => {
    Modal.confirm({
      title: '确认删除该用户？',
      content: '删除后用户数据将被清除，不可恢复。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await userApi.delete(user.id)
        message.success('用户已删除')
        if (selectedId === user.id) setSelectedId('')
        mutate(); globalMutate('nav-users-count')
      },
    })
  }

  const buildUserContextMenu = (user: UserRecord): MenuProps => {
    const isTargetSystemAdmin = user.email === SYSTEM_ADMIN_EMAIL
    const isTargetSelf = user.id === currentUser?.id
    return {
      items: [
        { key: 'open', label: '查看详情', icon: <InfoCircleOutlined /> },
        { key: 'roles', label: '查看角色', icon: <TeamOutlined /> },
        { key: 'perms', label: '查看权限', icon: <SafetyOutlined /> },
        { key: 'history', label: '变更记录', icon: <HistoryOutlined /> },
        { type: 'divider' as const },
        { key: 'edit', label: '编辑基本信息', icon: <EditOutlined />, disabled: isTargetSystemAdmin || !can('users', 'edit') },
        { key: 'reset', label: '重置密码', icon: <KeyOutlined />, disabled: !can('users', 'reset_pwd') },
        {
          key: 'toggle',
          label: user.status === 'active' ? '停用用户' : '启用用户',
          icon: user.status === 'active' ? <StopOutlined /> : <PlayCircleOutlined />,
          disabled: isTargetSystemAdmin || isTargetSelf || !can('users', 'disable'),
          danger: user.status === 'active',
        },
        { key: 'delete', label: '删除用户', icon: <DeleteOutlined />, disabled: isTargetSystemAdmin || isTargetSelf || !can('users', 'delete'), danger: true },
      ],
      onClick: ({ key }) => {
        if (key === 'open') selectUserForDetail(user)
        if (key === 'roles') selectUserForDetail(user, 'roles')
        if (key === 'perms') selectUserForDetail(user, 'perms')
        if (key === 'history') selectUserForDetail(user, 'history')
        if (key === 'edit') openEditUser(user)
        if (key === 'reset') void resetPasswordForUser(user)
        if (key === 'toggle') toggleStatusForUser(user)
        if (key === 'delete') deleteUserDirectly(user)
      },
    }
  }

  const handleRoleChange = async (newRoles: string[]) => {
    if (!selectedUser) return
    // Protect: admin user must keep super_admin
    if (selectedUser.email === SYSTEM_ADMIN_EMAIL && !newRoles.includes('super_admin')) {
      message.error('系统默认管理员必须保留超级管理员角色')
      return
    }
    try {
      await userApi.update(selectedUser.id, { roles: newRoles } as any)
      message.success('角色已更新'); mutate()
    } catch (e: any) { message.error(e?.response?.data?.message || '更新失败') }
  }

  // ── Tabs ──
  const rolesTab = selectedUser ? (
    <div>
      <div style={{ fontSize: 13, color: '#5F5E5A', marginBottom: 12 }}>
        用户最终权限 = 所有角色权限的并集 ∪ 用户独立权限。
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {userRoles.map(r => {
          const rc = getRoleColor(r)
          const isDisabled = roleMap[r]?.status === 'disabled'
          return (
            <Tag key={r} style={{
              color: isDisabled ? '#999' : rc.color,
              background: isDisabled ? '#f0f0f0' : rc.bg,
              border: isDisabled ? '1px dashed #d9d9d9' : 'none',
              fontSize: 12, fontWeight: 500, padding: '4px 12px',
            }}>
              {roleMap[r]?.displayName ?? r}
              {isDisabled && <span style={{ marginLeft: 4, fontSize: 10, color: '#ff4d4f' }}>已禁用</span>}
            </Tag>
          )
        })}
        {userRoles.length === 0 && <span style={{ color: '#ccc' }}>暂无角色</span>}
      </div>
      <PermGuard resource="users" action="edit">
        <div>
          <div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 6 }}>修改角色分配：</div>
          {isSystemAdmin && (
            <div style={{ fontSize: 11, color: '#faad14', marginBottom: 6 }}>
              <WarningOutlined /> 系统默认管理员的超级管理员角色不可移除
            </div>
          )}
          <Select mode="multiple" value={userRoles} onChange={handleRoleChange}
            style={{ width: '100%', maxWidth: 500 }} placeholder="选择角色（可多选）"
            tagRender={(props) => {
              const { label, value, closable, onClose } = props
              const isProtected = isSystemAdmin && value === 'super_admin'
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', background: '#f5f5f5',
                  borderRadius: 4, padding: '2px 8px', margin: '2px 4px 2px 0', fontSize: 12 }}>
                  {label}
                  {closable && !isProtected && (
                    <span onClick={onClose} style={{ marginLeft: 4, cursor: 'pointer', color: '#999' }}>×</span>
                  )}
                </span>
              )
            }}
            options={rolesList.map(r => ({
              label: r.displayName, value: r.name,
              disabled: isSystemAdmin && r.name === 'super_admin',
            }))} />
        </div>
      </PermGuard>
    </div>
  ) : null

  const permsTab = selectedUser ? (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: '#5F5E5A' }}>角色权限（灰色）不可修改，仅可添加额外权限。已禁用角色的权限不在此显示。</span>
        <div style={{ flex: 1 }} />
        {permDirty && <Tag color="warning" icon={<InfoCircleOutlined />}>有未保存的修改</Tag>}
        <PermGuard resource="permission" action="edit">
          <Button size="small" type="primary" icon={<SaveOutlined />}
            loading={permSaving} disabled={!permDirty} onClick={handlePermSave}>保存</Button>
        </PermGuard>
      </div>
      <UserPermMatrix perms={localPerms} onChange={handlePermChange}
        readonly={!can('permission', 'edit')} rolePerms={userRolePerms} />
    </div>
  ) : null

  const infoTab = selectedUser ? (
    <div style={{ maxWidth: 500, padding: '12px 0' }}>
      {[
        { label: '用户名', value: selectedUser.username },
        { label: '邮箱', value: selectedUser.email, mono: true },
        { label: '状态', value: selectedUser.status === 'active' ? '已启用' : '已停用' },
        { label: '创建时间', value: fmtTime(selectedUser.createdAt) },
        { label: '最近登录', value: fmtTime(selectedUser.lastLoginAt) || '未登录' },
      ].map(item => (
        <div key={item.label} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 4 }}>{item.label}</div>
          <div style={{ fontSize: 14, fontWeight: 500, fontFamily: item.mono ? 'monospace' : undefined }}>{item.value}</div>
        </div>
      ))}
    </div>
  ) : null

  const historyTab = (
    <div style={{ padding: '8px 0' }}>
      {userHistory.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无操作记录" />
      ) : (
        <Timeline items={userHistory.map((h: any) => ({
          color: h.action.includes('登录') ? 'green' : h.action.includes('禁用') ? 'red' : 'blue',
          children: (
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{h.action}</div>
              <div style={{ fontSize: 12, color: '#8C8C8C' }}>{h.userEmail} · {h.createdAt}</div>
            </div>
          ),
        }))} />
      )}
    </div>
  )

  return (
    <div className="atop-page-shell atop-admin-workbench" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <style>{`
        .user-tabs .ant-tabs { display: flex; flex-direction: column; height: 100%; }
        .user-tabs .ant-tabs-content-holder { flex: 1; overflow: auto; }
        .user-tabs .ant-tabs-content { height: 100%; }
        .user-tabs .ant-tabs-tabpane { height: 100%; overflow: auto; }
      `}</style>
      <PageHeader
        eyebrow="IDENTITY ADMIN"
        title="用户管理"
        subtitle="管理用户账户、角色分配与独立权限"
        extra={
          <PermGuard resource="users" action="create">
            <Space>
              <Button type="primary" icon={<PlusOutlined />}
                onClick={() => { setCreateOpen(true); createForm.resetFields(); setCreateColor(0) }}
                style={{ borderRadius: 6 }}>新建用户</Button>
              <Button icon={<DownloadOutlined />} onClick={downloadUserTemplate}>下载模板</Button>
              <Upload accept=".csv" showUploadList={false}
                beforeUpload={(file) => { handleBatchImport(file); return false }}>
                <Button icon={<ImportOutlined />} loading={importing}>批量导入</Button>
              </Upload>
            </Space>
          </PermGuard>
        }
      />

      <div className="atop-admin-brief">
        <SectionTitle
          icon={<TeamOutlined />}
          title="用户治理说明"
          note="这里用于维护平台登录账号、状态、角色分配和用户级独立权限；批量导入前建议先下载模板，按字段补齐后再上传。"
          tone="info"
        />
        <div className="atop-admin-brief-tags">
          <span>账号生命周期</span>
          <span>角色继承</span>
          <span>独立权限</span>
          <span>批量导入</span>
        </div>
      </div>

      {/* Main */}
      <div className="atop-admin-layout" style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left */}
        <div className="atop-admin-sidebar" style={{ width: 500, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Input prefix={<SearchOutlined />} placeholder="搜索姓名、邮箱..."
            value={search} onChange={e => { setSearch(e.target.value); setListPage(1) }}
            allowClear size="small" style={{ marginBottom: 8 }} />
          <Select size="small" value={statusFilter}
            onChange={(v: string) => { setStatusFilter(v); setListPage(1) }}
            style={{ width: '100%', marginBottom: 8 }}
            options={[
              { label: '全部', value: 'all' },
              { label: '已启用', value: 'active' },
              { label: '已停用', value: 'disabled' },
            ]} />

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {isLoading ? <Spin style={{ padding: 40, textAlign: 'center', display: 'block' }} /> :
            users.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用户" /> :
            users.map((user: UserRecord) => {
              const isActive = user.id === selectedId
              const roles = user.roles?.length ? user.roles : (user.role ? [user.role] : [])
              return (
                <Dropdown key={user.id} menu={buildUserContextMenu(user)} trigger={['contextMenu']}>
                <div
                  className={`atop-admin-list-item${isActive ? ' atop-admin-list-item-active' : ''}`}
                  onClick={() => selectUserForDetail(user)}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: isActive ? '2px solid #1677ff' : '2px solid transparent',
                    background: isActive ? '#F0F5FF' : '#fff',
                    transition: 'border-color 0.15s ease, background 0.15s ease', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                  <UserAvatar user={user} size={36} roleName={roles[0]} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {user.username}
                      </span>
                      {user.status === 'disabled' && <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>停用</Tag>}
                    </div>
                    <div style={{ fontSize: 11, color: '#8C8C8C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {user.email}
                    </div>
                  </div>
                </div>
                </Dropdown>
              )
            })}
          </div>

          {totalUsers > PAGE_SIZE && (
            <div style={{ paddingTop: 10, textAlign: 'center', borderTop: '1px solid #f0f0f0', marginTop: 4 }}>
              <Pagination size="small" current={listPage} total={totalUsers} pageSize={PAGE_SIZE}
                onChange={p => setListPage(p)} showSizeChanger={false} simple />
            </div>
          )}
        </div>

        {/* Right */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedUser ? (
            <>
              <Card size="small" className="atop-content-card atop-admin-detail-card" style={{ marginBottom: 12, borderRadius: 8 }} styles={{ body: { padding: '16px 20px' } }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <UserAvatar user={selectedUser} size={44} roleName={userRoles[0]} />
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 16, fontWeight: 700 }}>{selectedUser.username}</span>
                        <Tag color={selectedUser.status === 'active' ? 'success' : 'error'}>
                          {selectedUser.status === 'active' ? '已启用' : '已停用'}
                        </Tag>
                      </div>
                      <div style={{ fontSize: 12, color: '#8C8C8C', marginTop: 2 }}>{selectedUser.email}</div>
                    </div>
                  </div>
                  <Space size={4}>
                    {!isSystemAdmin && (
                      <PermGuard resource="users" action="edit">
                        <Button size="small" icon={<EditOutlined />}
                          onClick={() => {
                            setEditOpen(true)
                            editForm.setFieldsValue({
                              username: selectedUser.username,
                              roles: userRoles,
                              projects: selectedUser.projects ?? [],
                            })
                          }}>编辑基本信息</Button>
                      </PermGuard>
                    )}
                    <PermGuard resource="users" action="reset_pwd">
                      <Popconfirm title="确定重置密码？" description="将生成临时密码，用户下次登录需修改"
                        onConfirm={handleResetPassword}>
                        <Button size="small" icon={<KeyOutlined />}>重置密码</Button>
                      </Popconfirm>
                    </PermGuard>
                    {!isSystemAdmin && !isSelf && (
                      <PermGuard resource="users" action="disable">
                        <Popconfirm
                          title={selectedUser.status === 'active' ? '确定停用？' : '确定启用？'}
                          description={selectedUser.status === 'active' ? '停用后用户无法登录' : '启用后用户可正常登录'}
                          onConfirm={handleToggleStatus}>
                          <Button size="small"
                            danger={selectedUser.status === 'active'}
                            icon={selectedUser.status === 'active' ? <StopOutlined /> : <PlayCircleOutlined />}>
                            {selectedUser.status === 'active' ? '停用' : '启用'}
                          </Button>
                        </Popconfirm>
                      </PermGuard>
                    )}
                    {!isSystemAdmin && !isSelf && (
                      <PermGuard resource="users" action="delete">
                        <Popconfirm title="确定删除该用户？"
                          description="删除后用户数据将被清除，不可恢复"
                          onConfirm={handleDeleteUser} okText="确定删除" okButtonProps={{ danger: true }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      </PermGuard>
                    )}
                  </Space>
                </div>
                <div style={{ display: 'flex', gap: 32, marginTop: 16, paddingTop: 12, borderTop: '1px solid #f5f5f5' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#8C8C8C' }}>角色</div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {userRoles.length > 0 ? userRoles.map(r => {
                        const rc = getRoleColor(r)
                        const dis = roleMap[r]?.status === 'disabled'
                        return <Tag key={r} style={{ color: dis ? '#999' : rc.color, background: dis ? '#f0f0f0' : rc.bg, border: dis ? '1px dashed #d9d9d9' : 'none', fontSize: 11 }}>
                          {roleMap[r]?.displayName ?? r}{dis && ' (禁用)'}
                        </Tag>
                      }) : <span style={{ fontSize: 12, color: '#ccc' }}>—</span>}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#8C8C8C' }}>最近登录</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>{fmtTime(selectedUser.lastLoginAt) || '未登录'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#8C8C8C' }}>创建时间</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>{fmtTime(selectedUser.createdAt)}</div>
                  </div>
                </div>
              </Card>

              <Card size="small" className="user-tabs atop-content-card atop-admin-tabs-card" style={{ flex: 1, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                styles={{ body: { padding: '0 16px 16px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}>
                <Tabs activeKey={activeTab} onChange={handleTabChange} items={[
                  { key: 'roles', label: <span><TeamOutlined /> 角色配置 <Badge count={userRoles.length} size="small" style={{ marginLeft: 4 }} /></span>, children: rolesTab },
                  { key: 'perms', label: <span><SafetyOutlined /> 权限配置 <Badge count={totalUserPerms} size="small" style={{ marginLeft: 4 }} /></span>, children: permsTab },
                  { key: 'info', label: <span><InfoCircleOutlined /> 基本信息</span>, children: infoTab },
                  { key: 'history', label: <span><HistoryOutlined /> 操作记录</span>, children: historyTab },
                ]} />
              </Card>
            </>
          ) : (
            <Card className="atop-content-card atop-admin-empty-card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}>
              <Empty description="选择一个用户查看详情" />
            </Card>
          )}
        </div>
      </div>

      {/* Create Modal */}
      <Modal title="新建用户" open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        onOk={handleCreate} okText="创建" width={520}>
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="username" label="用户名" style={{ flex: 1 }}
              rules={[{ required: true, message: '请输入用户名' }, maxLenRule('username', '用户名')]}>
              <Input placeholder="姓名" {...inputLimit('username')} />
            </Form.Item>
            <Form.Item name="email" label="邮箱" style={{ flex: 1 }}
              rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }, maxLenRule('email', '邮箱')]}>
              <Input placeholder="user@example.com" {...inputLimit('email')} />
            </Form.Item>
          </div>
          <Form.Item label="初始密码">
            <Input value="#PassW0rd" disabled />
            <div style={{ marginTop: 6, color: '#8C8C8C', fontSize: 12 }}>创建用户时由系统自动设置，用户首次登录后需修改。</div>
          </Form.Item>
          <Form.Item name="roles" label="角色">
            <Select mode="multiple" placeholder="选择角色（可多选）"
              options={rolesList.map(r => ({ label: r.displayName, value: r.name }))} />
          </Form.Item>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>用户色卡</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {COLOR_PALETTE.map((c, i) => (
                <div key={i} onClick={() => setCreateColor(i)}
                  style={{
                    width: 36, height: 36, borderRadius: 8, background: c.bg, color: c.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    border: createColor === i ? '3px solid #1677ff' : '3px solid transparent',
                    boxShadow: createColor === i ? '0 0 0 2px rgba(22,119,255,0.2)' : 'none',
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}>
                  {(createForm.getFieldValue('username') || 'A').charAt(0).toUpperCase()}
                </div>
              ))}
            </div>
          </div>
        </Form>
      </Modal>

      {/* Edit Modal */}
      <Modal title={`编辑用户 · ${selectedUser?.username}`} open={editOpen}
        onCancel={() => setEditOpen(false)} onOk={handleEdit} okText="保存" width={520}>
        <Form form={editForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="邮箱"><Input disabled value={selectedUser?.email} /></Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true }, maxLenRule('username', '用户名')]}><Input {...inputLimit('username')} /></Form.Item>
          <Form.Item name="roles" label="角色"
            >
            <Select mode="multiple" placeholder="选择角色（可多选）"
              options={rolesList.map(r => ({ label: r.displayName, value: r.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
