import { useState, useCallback, useMemo, useEffect, Fragment } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  Card, Button, Space, Tag, message, Modal, Form, Input, Select,
  Switch, Spin, Badge, Tabs, Avatar, Empty, Popconfirm,
  Progress, Alert, Segmented, List, Timeline, Pagination, Tooltip, Dropdown,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined,
  SafetyOutlined, CrownOutlined, SearchOutlined,
  SaveOutlined, InfoCircleOutlined, ReloadOutlined, TeamOutlined,
  UserOutlined, HistoryOutlined, CheckCircleOutlined, StopOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
import {
  roleApi, permissionApi,
  type RoleItem, type PermissionMap,
} from '@/api/permission'
import { userApi } from '@/api/admin'
import { PermGuard, usePermission, useReloadPermissions } from '@/hooks/usePermission'
import PageHeader from '@/components/common/PageHeader'
import SectionTitle from '@/components/common/SectionTitle'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

// ── Constants ─────────────────────────────────────────────────────────────
const COLOR_PALETTE = [
  { bg: '#1A1A18', color: '#fff' },
  { bg: '#3F3F3F', color: '#fff' },
  { bg: '#4527A0', color: '#fff' },
  { bg: '#283593', color: '#fff' },
  { bg: '#5C6BC0', color: '#fff' },
  { bg: '#00838F', color: '#fff' },
  { bg: '#E37400', color: '#fff' },
  { bg: '#C5221F', color: '#fff' },
  { bg: '#AD1457', color: '#fff' },
  { bg: '#558B2F', color: '#fff' },
  { bg: '#8D6E63', color: '#fff' },
  { bg: '#78909C', color: '#fff' },
]

const ACT_LABELS: Record<string, string> = {
  view: '查看', create: '新建', edit: '编辑', delete: '删除', trigger: '触发',
  import: '导入', clone: '复制', ping: '连通', sync: '同步', reset_pwd: '重置密码',
  disable: '禁用', fullscreen: '全屏',
}

const CAT_MAP: Record<string, string> = {
  pipeline: '任务流转', jenkins: '任务流转',
  vars: '资源配置', dimensions: '资源配置',
  users: '系统管理', roles: '系统管理', permission: '系统管理', audit: '系统管理',
  cleanup: '系统管理', notification_rule: '系统管理',
}

// ── Helpers ────────────────────────────────────────────────────────────────
function getRoleIcon(name: string, displayName: string): string {
  if (name === 'super_admin') return displayName.charAt(0) || 'S'
  return displayName.charAt(0)
}

function getRoleCardColor(name: string, index: number) {
  if (name === 'super_admin') return COLOR_PALETTE[0]
  return COLOR_PALETTE[((index >= 0 ? index : 0) % (COLOR_PALETTE.length - 1)) + 1]
}

function userInitial(name?: string): string {
  return name?.charAt(0)?.toUpperCase() || '?'
}

function buildAllPerms(matrix: any[]): PermissionMap {
  const perms: PermissionMap = {}
  for (const m of matrix) {
    perms[m.resource] = {}
    for (const a of m.actions) perms[m.resource][a.action] = true
  }
  return perms
}

function enabledPerm(perms: PermissionMap, resource: string, action: string) {
  return perms?.[resource]?.[action] === true
}

function buildPermissionDiff(before: PermissionMap, after: PermissionMap, matrix: any[]) {
  const resources = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
    ...matrix.map((item) => item.resource),
  ])
  const changes: Array<{ resource: string; resourceLabel: string; added: string[]; removed: string[] }> = []

  resources.forEach((resource) => {
    const matrixItem = matrix.find((item) => item.resource === resource)
    const actions = new Set<string>([
      ...Object.keys(before?.[resource] ?? {}),
      ...Object.keys(after?.[resource] ?? {}),
      ...(matrixItem?.actions ?? []).map((item: any) => item.action),
    ])
    const added: string[] = []
    const removed: string[] = []
    actions.forEach((action) => {
      const wasEnabled = enabledPerm(before, resource, action)
      const isEnabled = enabledPerm(after, resource, action)
      if (wasEnabled === isEnabled) return
      const label = ACT_LABELS[action] ?? matrixItem?.actions?.find((item: any) => item.action === action)?.label ?? action
      if (isEnabled) added.push(label)
      else removed.push(label)
    })
    if (added.length || removed.length) {
      changes.push({
        resource,
        resourceLabel: matrixItem?.label ?? resource,
        added,
        removed,
      })
    }
  })

  return changes
}

interface PresetOption { key: string; label: string; desc: string; build: () => PermissionMap }

function buildPresets(cloneSource?: { name: string; perms: PermissionMap }): PresetOption[] {
  const presets: PresetOption[] = []
  if (cloneSource) {
    presets.push({ key: 'clone', label: `复制自「${cloneSource.name}」`, desc: '保留源角色的全部权限配置', build: () => ({ ...cloneSource.perms }) })
  }
  presets.push(
    { key: 'readonly', label: '只读观察', desc: '所有资源仅查看权限', build: () => ({
      pipeline: { view: true }, jenkins: { view: true },
      vars: { view: true }, dimensions: { view: true },
      users: { view: true }, roles: { view: true }, audit: { view: true },
      notification_rule: { view: true },
      permission: { view: true }, cleanup: { view: true },
    })},
    { key: 'ops', label: '运维操作', desc: '查看+执行+编辑常用资源', build: () => ({
      pipeline: { view: true, trigger: true },
      jenkins: { view: true, ping: true, sync: true }, vars: { view: true, create: true, edit: true },
      dimensions: { view: true },
      notification_rule: { view: true, create: true, edit: true },
    })},
    { key: 'dev', label: '研发开发', desc: '流水线/配置/变量读写', build: () => ({
      pipeline: { view: true, create: true, edit: true, trigger: true }, jenkins: { view: true },
      vars: { view: true, create: true, edit: true }, dimensions: { view: true },
    })},
    { key: 'empty', label: '空白配置', desc: '无任何权限，稍后手动配置', build: () => ({}) },
  )
  return presets
}

function getHistoryColor(action: string) {
  if (action.startsWith('创建')) return 'green'
  if (action.startsWith('克隆')) return 'purple'
  if (action.startsWith('删除') || action.startsWith('移出')) return 'red'
  if (action.startsWith('分配')) return 'cyan'
  if (action.startsWith('修改权限')) return 'blue'
  return 'blue'
}

// ── Sub-components ────────────────────────────────────────────────────────
function PermissionMatrix({ perms, onChange, readonly, searchText }: {
  perms: PermissionMap; onChange: (p: PermissionMap) => void; readonly?: boolean; searchText?: string
}) {
  const { data: matrix = [] } = useSWR('perm-matrix-role', permissionApi.getMatrix, { revalidateOnFocus: false })

  const toggle = useCallback((resource: string, action: string, val: boolean) => {
    onChange({ ...perms, [resource]: { ...(perms[resource] ?? {}), [action]: val } })
  }, [perms, onChange])

  const toggleAll = useCallback((resource: string, val: boolean) => {
    const actions = matrix.find(m => m.resource === resource)?.actions ?? []
    const next = { ...perms, [resource]: { ...(perms[resource] ?? {}) } }
    for (const a of actions) next[resource][a.action] = val
    onChange(next)
  }, [perms, matrix, onChange])

  if (!matrix.length) return <Spin style={{ display: 'block', padding: 40, textAlign: 'center' }} />

  const allActions = Array.from(new Set(matrix.flatMap(m => m.actions.map(a => a.action))))
  const search = searchText || ''
  const filtered = search ? matrix.filter(m => m.resource.includes(search) || m.label.includes(search)) : matrix
  const groups: Record<string, typeof matrix> = {}
  for (const item of filtered) { const cat = CAT_MAP[item.resource] ?? '其他'; if (!groups[cat]) groups[cat] = []; groups[cat].push(item) }

  const totalPerms = matrix.reduce((s, m) => s + m.actions.length, 0)
  const enabledPerms = matrix.reduce((s, m) => s + m.actions.filter(a => perms[m.resource]?.[a.action] === true).length, 0)

  return (
    <div>
      <div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 8 }}>
        已授权 <b style={{ color: '#1677ff' }}>{enabledPerms}</b> / {totalPerms}{' '}
        覆盖率 <b style={{ color: '#1677ff' }}>{totalPerms > 0 ? Math.round(enabledPerms / totalPerms * 100) : 0}%</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: '#FAFAFA' }}>
            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#5F5E5A', borderBottom: '2px solid #f0f0f0', minWidth: 130, position: 'sticky', left: 0, background: '#FAFAFA', zIndex: 1 }}>资源</th>
            {allActions.map(a => <th key={a} style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 500, color: '#8C8C8C', borderBottom: '2px solid #f0f0f0', minWidth: 56, fontSize: 12 }}>{ACT_LABELS[a] ?? a}</th>)}
            <th style={{ padding: '8px 4px', textAlign: 'center', color: '#bfbfbf', borderBottom: '2px solid #f0f0f0', minWidth: 56, fontSize: 12 }}>全选</th>
          </tr></thead>
          <tbody>
            {Object.entries(groups).map(([cat, items]) => (
              <Fragment key={`g-${cat}`}>
                <tr><td colSpan={allActions.length + 2} style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600, color: '#8C8C8C', background: '#F5F5F4', borderBottom: '1px solid #eee', textAlign: 'right' }}>{cat} · {items.length} 项资源</td></tr>
                {items.map((item, idx) => {
                  const hasAll = item.actions.every(a => perms[item.resource]?.[a.action] === true)
                  return (
                    <tr key={item.resource} style={{ background: idx % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500, color: '#1A1A18', borderBottom: '1px solid #f5f5f5', position: 'sticky', left: 0, background: idx % 2 === 0 ? '#fff' : '#FAFBFC', zIndex: 1 }}>
                        <span style={{ fontSize: 11, color: '#9C9A92', background: '#F0F0F0', padding: '1px 5px', borderRadius: 3, marginRight: 6, fontFamily: 'monospace' }}>{item.resource}</span>{item.label}
                      </td>
                      {allActions.map(act => {
                        const supported = item.actions.some(a => a.action === act)
                        return <td key={act} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid #f5f5f5' }}>
                          {supported ? <Switch size="small" checked={perms[item.resource]?.[act] === true} disabled={readonly} onChange={v => toggle(item.resource, act, v)} checkedChildren="✓" unCheckedChildren="✗" /> : <span style={{ color: '#e8e8e8' }}>—</span>}
                        </td>
                      })}
                      <td style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid #f5f5f5' }}>
                        {!readonly && <Switch size="small" checked={hasAll} onChange={v => toggleAll(item.resource, v)} checkedChildren="全" unCheckedChildren="无" />}
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ColorCardPicker({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>角色色卡</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {COLOR_PALETTE.map((c, i) => (
          <div key={i} onClick={() => onChange(i)} style={{
            width: 36, height: 36, borderRadius: 8, background: c.bg, color: c.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 700, cursor: 'pointer',
            border: value === i ? '3px solid #1677ff' : '3px solid transparent',
            boxShadow: value === i ? '0 0 0 2px rgba(22,119,255,0.2)' : 'none',
          }}>{(label || 'A').charAt(0)}</div>
        ))}
      </div>
    </div>
  )
}

function PresetPicker({ options, value, onChange }: { options: PresetOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>初始权限预设</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {options.map(p => (
          <div key={p.key} onClick={() => onChange(p.key)} style={{
            padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
            border: value === p.key ? '2px solid #1677ff' : '2px solid #f0f0f0',
            background: value === p.key ? '#F0F5FF' : '#fff',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: value === p.key ? '#1677ff' : '#1A1A18' }}>{p.label}</span>
              {value === p.key && <CheckCircleOutlined style={{ color: '#1677ff' }} />}
            </div>
            <div style={{ fontSize: 11, color: '#8C8C8C', marginTop: 2 }}>{p.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

const LIST_PAGE_SIZE = 12

// ── Main Page ─────────────────────────────────────────────────────────────
export default function RolePage() {
  const [selectedId, setSelectedId] = useState('')
  const [listPage, setListPage] = useState(1)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'builtin' | 'custom'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [permDirty, setPermDirty] = useState(false)
  const [permSaving, setPermSaving] = useState(false)
  const [localPerms, setLocalPerms] = useState<PermissionMap>({})
  const [baselinePerms, setBaselinePerms] = useState<PermissionMap>({})
  const [matrixSearch, setMatrixSearch] = useState('')
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [cloneForm] = Form.useForm()
  const [selectedColor, setSelectedColor] = useState(4)
  const [cloneColor, setCloneColor] = useState(4)
  const [selectedPreset, setSelectedPreset] = useState('readonly')
  const [clonePreset, setClonePreset] = useState('clone')
  const [userSearch, setUserSearch] = useState('')
  const [userStatusFilter, setUserStatusFilter] = useState<'all' | 'active' | 'disabled'>('all')
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignUserIds, setAssignUserIds] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState('perms')
  const { can } = usePermission()
  const reloadPermissions = useReloadPermissions()

  const { data: roles = [], isLoading, mutate } = useSWR('admin-roles', roleApi.list)
  const { data: matrix = [] } = useSWR('perm-matrix-stats', permissionApi.getMatrix, { revalidateOnFocus: false })

  const filteredRoles = useMemo(() => {
    let list = roles
    if (filter === 'builtin') list = list.filter(r => r.isBuiltin)
    if (filter === 'custom') list = list.filter(r => !r.isBuiltin)
    if (search) { const s = search.toLowerCase(); list = list.filter(r => r.name.toLowerCase().includes(s) || r.displayName.toLowerCase().includes(s) || r.description?.toLowerCase().includes(s)) }
    return list
  }, [roles, filter, search])

  const pagedRoles = useMemo(
    () => filteredRoles.slice((listPage - 1) * LIST_PAGE_SIZE, listPage * LIST_PAGE_SIZE),
    [filteredRoles, listPage]
  )

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredRoles.length / LIST_PAGE_SIZE))
    if (listPage > maxPage) {
      setListPage(maxPage)
    }
  }, [filteredRoles.length, listPage])

  useEffect(() => {
    if (pagedRoles.length === 0) {
      if (selectedId) {
        setSelectedId('')
      }
      return
    }

    const hasSelected = pagedRoles.some((role) => role.id === selectedId)
    if (!hasSelected) {
      setSelectedId(pagedRoles[0].id)
      setPermDirty(false)
      setActiveTab('perms')
    }
  }, [pagedRoles, selectedId])

  const selectedRole = pagedRoles.find(r => r.id === selectedId)
  const selectedIdx = pagedRoles.findIndex(r => r.id === selectedId)
  const isSuperAdmin = selectedRole?.name === 'super_admin'

  const { mutate: mutatePerms } = useSWR(
    selectedRole ? ['role-perms-page', selectedRole.name] : null,
    () => permissionApi.getRolePermissions(selectedRole!.name),
    { revalidateOnFocus: false, onSuccess: (d: PermissionMap) => { setLocalPerms(d); setBaselinePerms(d); setPermDirty(false) } }
  )

  const { data: roleUsers = [], mutate: mutateRoleUsers } = useSWR(
    selectedRole ? ['role-users', selectedRole.name] : null,
    () => roleApi.getUsers(selectedRole!.name),
    { revalidateOnFocus: true }
  )

  const { data: allUsersData } = useSWR(
    assignOpen ? 'all-users-for-assign' : null,
    () => userApi.list({ page: 1, pageSize: 999 }),
    { revalidateOnFocus: false }
  )
  const allUsers = (allUsersData as any)?.items ?? []

  const { data: roleHistory = [], mutate: mutateHistory } = useSWR(
    selectedRole ? ['role-history', selectedRole.id] : null,
    () => roleApi.getHistory(selectedRole!.id),
    { revalidateOnFocus: true }
  )

  // Tab change: force refetch
  const handleTabChange = (key: string) => {
    setActiveTab(key)
    if (!selectedRole) return
    if (key === 'users') mutateRoleUsers()
    if (key === 'history') mutateHistory()
  }

  const handlePermChange = (p: PermissionMap) => { setLocalPerms(p); setPermDirty(true) }
  const handlePermSave = async () => {
    if (!selectedRole) return
    const diff = buildPermissionDiff(baselinePerms, localPerms, matrix)
    if (diff.length === 0) {
      message.info('没有权限变更')
      setPermDirty(false)
      return
    }

    Modal.confirm({
      title: '确认保存权限变更？',
      width: 560,
      okText: '保存权限',
      cancelText: '取消',
      content: (
        <div className="atop-permission-diff">
          <div className="atop-permission-diff-summary">
            将更新角色「{selectedRole.displayName}」的权限，请确认本次变更范围。
          </div>
          {diff.map((item) => (
            <div className="atop-permission-diff-row" key={item.resource}>
              <strong>{item.resourceLabel}</strong>
              <Space size={[6, 6]} wrap>
                {item.added.map((label) => <Tag color="green" key={`add-${label}`}>新增 {label}</Tag>)}
                {item.removed.map((label) => <Tag color="red" key={`remove-${label}`}>移除 {label}</Tag>)}
              </Space>
            </div>
          ))}
        </div>
      ),
      onOk: async () => {
        setPermSaving(true)
        try {
          await permissionApi.updateRolePermissions(selectedRole.name, localPerms)
          message.success('权限已保存')
          await mutatePerms()
          setBaselinePerms(localPerms)
          setPermDirty(false)
          reloadPermissions()
          mutate()
        } catch (e: any) {
          message.error(e?.response?.data?.message || '保存失败')
          throw e
        } finally {
          setPermSaving(false)
        }
      },
    })
  }

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      const preset = buildPresets().find(p => p.key === selectedPreset)
      await roleApi.create({ name: values.name, displayName: values.displayName, description: values.description || '', perms: preset?.build() ?? {} })
      message.success('角色已创建'); setCreateOpen(false); createForm.resetFields(); mutate(); globalMutate('nav-roles-count')
    } catch (e: any) { if (e?.response?.data?.message) message.error(e.response.data.message) }
  }

  const handleEdit = async () => {
    if (!selectedRole) return
    try { const values = await editForm.validateFields(); await roleApi.update(selectedRole.id, { displayName: values.displayName, description: values.description }); message.success('角色已更新'); setEditOpen(false); mutate() }
    catch (e: any) { if (e?.response?.data?.message) message.error(e.response.data.message) }
  }

  const handleClone = async () => {
    if (!selectedRole) return
    try {
      const values = await cloneForm.validateFields()
      const preset = buildPresets({ name: selectedRole.displayName, perms: localPerms }).find(p => p.key === clonePreset)
      await roleApi.create({ name: values.name, displayName: values.displayName, description: values.description || selectedRole.description, perms: preset?.build() ?? localPerms, cloneFrom: selectedRole.displayName })
      message.success('角色已克隆'); setCloneOpen(false); cloneForm.resetFields(); mutate(); globalMutate('nav-roles-count')
    } catch (e: any) { if (e?.response?.data?.message) message.error(e.response.data.message) }
  }

  const handleToggleRoleStatus = async () => {
    if (!selectedRole) return
    const newStatus = selectedRole.status === 'active' ? 'disabled' : 'active'
    try {
      await roleApi.toggleStatus(selectedRole.id, newStatus)
      message.success(newStatus === 'active' ? '角色已启用' : '角色已禁用')
      mutate(); globalMutate('nav-roles-count')
    } catch (e: any) { message.error(e?.response?.data?.message || '操作失败') }
  }

  const handleDelete = async () => {
    if (!selectedRole) return
    try { await roleApi.delete(selectedRole.id); message.success('角色已删除'); setSelectedId(''); mutate(); globalMutate('nav-roles-count') }
    catch (e: any) { message.error(e?.response?.data?.message || '删除失败') }
  }

  const selectRoleForDetail = (role: RoleItem, tab = 'perms') => {
    setSelectedId(role.id)
    setPermDirty(false)
    setActiveTab(tab)
  }

  const openEditRole = (role: RoleItem) => {
    selectRoleForDetail(role)
    setEditOpen(true)
    editForm.setFieldsValue({ displayName: role.displayName, description: role.description })
  }

  const openCloneRole = async (role: RoleItem) => {
    selectRoleForDetail(role)
    setClonePreset('clone')
    setCloneColor(4)
    cloneForm.setFieldsValue({ displayName: `${role.displayName} 副本`, name: `${role.name}_copy`, description: role.description })
    try {
      const perms = await permissionApi.getRolePermissions(role.name)
      setLocalPerms(perms)
    } catch {
      /* keep current permission draft */
    }
    setCloneOpen(true)
  }

  const toggleRoleStatusDirectly = (role: RoleItem) => {
    const newStatus = role.status === 'active' ? 'disabled' : 'active'
    Modal.confirm({
      title: newStatus === 'active' ? '确认启用该角色？' : '确认禁用该角色？',
      content: newStatus === 'active' ? '启用后该角色下用户将恢复角色权限。' : '禁用后该角色下用户将暂时失去该角色权限。',
      okText: newStatus === 'active' ? '启用' : '禁用',
      okButtonProps: { danger: newStatus === 'disabled' },
      onOk: async () => {
        await roleApi.toggleStatus(role.id, newStatus)
        message.success(newStatus === 'active' ? '角色已启用' : '角色已禁用')
        mutate(); globalMutate('nav-roles-count')
      },
    })
  }

  const deleteRoleDirectly = (role: RoleItem) => {
    Modal.confirm({
      title: '确认删除该角色？',
      content: `删除后该角色下 ${role.userCount || 0} 个用户将被移出，角色权限配置清除，用户独立权限保留。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await roleApi.delete(role.id)
        message.success('角色已删除')
        if (selectedId === role.id) setSelectedId('')
        mutate(); globalMutate('nav-roles-count')
      },
    })
  }

  const buildRoleContextMenu = (role: RoleItem): MenuProps => {
    const protectedRole = role.isBuiltin || role.name === 'super_admin'
    return {
      items: [
        { key: 'open', label: '查看详情', icon: <InfoCircleOutlined /> },
        { key: 'perms', label: '权限配置', icon: <SafetyOutlined /> },
        { key: 'users', label: '关联用户', icon: <UserOutlined /> },
        { key: 'history', label: '变更记录', icon: <HistoryOutlined /> },
        { type: 'divider' as const },
        { key: 'clone', label: '克隆角色', icon: <CopyOutlined />, disabled: role.name === 'super_admin' || !can('roles', 'create') },
        { key: 'edit', label: '编辑基本信息', icon: <EditOutlined />, disabled: role.isBuiltin || !can('roles', 'edit') },
        {
          key: 'toggle',
          label: role.status === 'active' ? '禁用角色' : '启用角色',
          icon: role.status === 'active' ? <StopOutlined /> : <PlayCircleOutlined />,
          disabled: protectedRole || !can('roles', 'edit'),
          danger: role.status === 'active',
        },
        { key: 'delete', label: '删除角色', icon: <DeleteOutlined />, disabled: protectedRole || !can('roles', 'delete'), danger: true },
      ],
      onClick: ({ key }) => {
        if (key === 'open') selectRoleForDetail(role)
        if (key === 'perms') selectRoleForDetail(role, 'perms')
        if (key === 'users') selectRoleForDetail(role, 'users')
        if (key === 'history') selectRoleForDetail(role, 'history')
        if (key === 'clone') void openCloneRole(role)
        if (key === 'edit') openEditRole(role)
        if (key === 'toggle') toggleRoleStatusDirectly(role)
        if (key === 'delete') deleteRoleDirectly(role)
      },
    }
  }

  const filteredRoleUsers = useMemo(() => {
    let list = roleUsers as any[]
    if (userSearch) { const s = userSearch.toLowerCase(); list = list.filter((u: any) => u.username?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s)) }
    if (userStatusFilter !== 'all') list = list.filter((u: any) => u.status === userStatusFilter)
    return list
  }, [roleUsers, userSearch, userStatusFilter])

  const handleRemoveUser = async (userId: string) => {
    if (!selectedRole) return
    try { await roleApi.removeUser(selectedRole.name, userId); message.success('已移出'); await mutateRoleUsers(undefined, { revalidate: true }); mutate() }
    catch (e: any) { message.error(e?.response?.data?.message || '操作失败') }
  }

  const handleAssignUsers = async () => {
    if (!selectedRole || assignUserIds.length === 0) return
    try { await roleApi.assignUsers(selectedRole.name, assignUserIds); message.success(`已分配 ${assignUserIds.length} 个用户`); setAssignOpen(false); setAssignUserIds([]); await mutateRoleUsers(undefined, { revalidate: true }); mutate() }
    catch (e: any) { message.error(e?.response?.data?.message || '分配失败') }
  }

  const assignableUsers = useMemo(() => {
    const existingIds = new Set((roleUsers as any[]).map((u: any) => u.id))
    return allUsers.filter((u: any) => !existingIds.has(u.id) && u.status === 'active')
  }, [allUsers, roleUsers])

  const totalPerms = matrix.reduce((s, m) => s + m.actions.length, 0)
  const enabledPerms = isSuperAdmin ? totalPerms : matrix.reduce((s, m) => s + m.actions.filter(a => localPerms[m.resource]?.[a.action] === true).length, 0)
  const coverPct = totalPerms > 0 ? Math.round(enabledPerms / totalPerms * 100) : 0

  return (
    <div className="atop-page-shell atop-admin-workbench" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <style>{`
        .role-tabs .ant-tabs { display: flex; flex-direction: column; height: 100%; }
        .role-tabs .ant-tabs-content-holder { flex: 1; overflow: auto; }
        .role-tabs .ant-tabs-content { height: 100%; }
        .role-tabs .ant-tabs-tabpane { height: 100%; overflow: auto; }
      `}</style>
      <PageHeader
        eyebrow="ROLE GOVERNANCE"
        title="角色管理"
        subtitle="管理角色与其对应的资源访问权限"
        extra={
          <PermGuard resource="roles" action="create">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setCreateOpen(true); setSelectedPreset('readonly'); setSelectedColor(4) }} style={{ borderRadius: 6 }}>新建角色</Button>
          </PermGuard>
        }
      />

      <div className="atop-admin-brief atop-admin-brief-role">
        <SectionTitle
          icon={<SafetyOutlined />}
          title="角色治理说明"
          note="角色是一组权限集合，用户可同时拥有多个角色，最终权限为所有角色权限的并集；系统预置角色用于平台基础治理，不允许直接编辑。"
          tone="success"
        />
        <div className="atop-admin-brief-tags">
          <span>权限集合</span>
          <span>多角色继承</span>
          <span>系统预置</span>
          <span>变更可追踪</span>
        </div>
      </div>

      <div className="atop-admin-layout" style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left: Role List */}
        <div className="atop-admin-sidebar" style={{ width: 500, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Input prefix={<SearchOutlined />} placeholder="搜索角色名称、标识、描述..." value={search} onChange={e => { setSearch(e.target.value); setListPage(1) }} allowClear size="small" style={{ marginBottom: 8 }} />
          <Segmented size="small" value={filter} onChange={v => { setFilter(v as any); setListPage(1) }} block
            options={[
              { label: `全部 ${roles.length}`, value: 'all' },
              { label: `系统 ${roles.filter(r => r.isBuiltin).length}`, value: 'builtin' },
              { label: `自定义 ${roles.filter(r => !r.isBuiltin).length}`, value: 'custom' },
            ]} style={{ marginBottom: 8 }} />
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {isLoading ? <Spin style={{ padding: 40, textAlign: 'center', display: 'block' }} /> :
            filteredRoles.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无角色" /> :
            pagedRoles.map((role, idx) => {
              const cc = getRoleCardColor(role.name, idx)
              const isActive = role.id === selectedId
              return (
                <Dropdown key={role.id} menu={buildRoleContextMenu(role)} trigger={['contextMenu']}>
                <div className={`atop-admin-list-item${isActive ? ' atop-admin-list-item-active' : ''}`} onClick={() => selectRoleForDetail(role)}
                  style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: isActive ? '2px solid #1677ff' : '2px solid transparent', background: isActive ? '#F0F5FF' : '#fff', transition: 'border-color 0.15s ease, background 0.15s ease', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar size={36} style={{ background: cc.bg, color: cc.color, fontWeight: 700, fontSize: 15, flexShrink: 0 }}>{getRoleIcon(role.name, role.displayName)}</Avatar>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{role.displayName}</span>
                      {role.isBuiltin && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>系统</Tag>}
                      {role.status === 'disabled' && <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>禁用</Tag>}
                    </div>
                    <div style={{ fontSize: 11, color: '#8C8C8C', fontFamily: 'monospace' }}>{role.name} · {role.userCount} 人</div>
                  </div>
                </div>
                </Dropdown>
              )
            })}
          </div>

          {filteredRoles.length > LIST_PAGE_SIZE && (
            <div style={{ paddingTop: 10, textAlign: 'center', borderTop: '1px solid #f0f0f0', marginTop: 4 }}>
              <Pagination size="small" current={listPage} total={filteredRoles.length} pageSize={LIST_PAGE_SIZE}
                onChange={p => setListPage(p)} showSizeChanger={false} simple />
            </div>
          )}
        </div>

        {/* Right: Detail */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedRole ? (<>
            <Card size="small" className="atop-content-card atop-admin-detail-card" style={{ marginBottom: 12, borderRadius: 8 }} styles={{ body: { padding: '16px 20px' } }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Avatar size={44} style={{ background: getRoleCardColor(selectedRole.name, selectedIdx >= 0 ? selectedIdx : 0).bg, color: getRoleCardColor(selectedRole.name, selectedIdx >= 0 ? selectedIdx : 0).color, fontWeight: 700, fontSize: 18 }}>
                    {getRoleIcon(selectedRole.name, selectedRole.displayName)}
                  </Avatar>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16, fontWeight: 700 }}>{selectedRole.displayName}</span>
                      {selectedRole.isBuiltin && <Tag color="blue">系统</Tag>}
                      {selectedRole.status === 'disabled' && <Tag color="error">已禁用</Tag>}
                    </div>
                    <div style={{ fontSize: 12, color: '#8C8C8C', marginTop: 2 }}>{selectedRole.description || '暂无描述'}</div>
                  </div>
                </div>
                <Space size={4}>
                  {!isSuperAdmin && <PermGuard resource="roles" action="create"><Button size="small" icon={<CopyOutlined />} onClick={() => { setCloneOpen(true); setClonePreset('clone'); setCloneColor(4); cloneForm.setFieldsValue({ displayName: selectedRole.displayName + ' 副本', name: selectedRole.name + '_copy', description: selectedRole.description }) }}>克隆</Button></PermGuard>}
                  {!selectedRole.isBuiltin && <PermGuard resource="roles" action="edit"><Button size="small" icon={<EditOutlined />} onClick={() => { setEditOpen(true); editForm.setFieldsValue({ displayName: selectedRole.displayName, description: selectedRole.description }) }}>编辑基本信息</Button></PermGuard>}
                  {!selectedRole.isBuiltin && (
                    <PermGuard resource="roles" action="edit">
                      <Popconfirm
                        title={selectedRole.status === 'active' ? '确定禁用该角色？' : '确定启用该角色？'}
                        description={selectedRole.status === 'active' ? '禁用后该角色下所有用户将暂时失去该角色权限，启用后自动恢复' : '启用后该角色下所有用户将恢复该角色权限'}
                        onConfirm={handleToggleRoleStatus}>
                        <Button size="small"
                          icon={selectedRole.status === 'active' ? <StopOutlined /> : <PlayCircleOutlined />}
                          danger={selectedRole.status === 'active'}>
                          {selectedRole.status === 'active' ? '禁用' : '启用'}
                        </Button>
                      </Popconfirm>
                    </PermGuard>
                  )}
                  {!selectedRole.isBuiltin && <PermGuard resource="roles" action="delete">
                    <Popconfirm title="确定删除该角色？" description={`删除后该角色下 ${selectedRole.userCount || 0} 个用户将被移出，角色权限配置清除，用户独立权限保留。`} onConfirm={handleDelete} okText="确定删除" okButtonProps={{ danger: true }}>
                      <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                  </PermGuard>}
                </Space>
              </div>
              <div style={{ display: 'flex', gap: 32, marginTop: 16, paddingTop: 12, borderTop: '1px solid #f5f5f5' }}>
                <div><div style={{ fontSize: 11, color: '#8C8C8C' }}>角色标识</div><div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, marginTop: 2 }}>{selectedRole.name}</div></div>
                <div><div style={{ fontSize: 11, color: '#8C8C8C' }}>关联用户</div><div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}><TeamOutlined style={{ marginRight: 4 }} />{selectedRole.userCount} 人</div></div>
                <div><div style={{ fontSize: 11, color: '#8C8C8C' }}>权限覆盖</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{enabledPerms} / {totalPerms}</span>
                    <Progress percent={coverPct} size="small" style={{ width: 80, margin: 0 }} showInfo={false} />
                    <span style={{ fontSize: 12, color: '#8C8C8C' }}>{coverPct}%</span>
                  </div>
                </div>
                <div><div style={{ fontSize: 11, color: '#8C8C8C' }}>最近修改</div><div style={{ fontSize: 13, marginTop: 2 }}>{selectedRole.createdAt}{selectedRole.creatorName && <span style={{ color: '#8C8C8C', marginLeft: 8 }}>{selectedRole.creatorName}</span>}</div></div>
              </div>
            </Card>

            <Card size="small" className="role-tabs atop-content-card atop-admin-tabs-card" style={{ flex: 1, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }} styles={{ body: { padding: '0 16px 16px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}>
              <Tabs activeKey={activeTab} onChange={handleTabChange} items={[
                { key: 'perms', label: <span><SafetyOutlined /> 权限配置 <Badge count={enabledPerms} size="small" style={{ marginLeft: 4 }} /></span>, children: (
                  <div>
                    {isSuperAdmin ? <Alert type="info" showIcon icon={<CrownOutlined />} message="超级管理员拥有全部权限，不可修改" style={{ marginBottom: 12 }} /> : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <Input prefix={<SearchOutlined />} placeholder="搜索资源名或标识..." value={matrixSearch} onChange={e => setMatrixSearch(e.target.value)} style={{ width: 200 }} allowClear size="small" />
                        <div style={{ flex: 1 }} />
                        {permDirty && <Tag color="warning" icon={<InfoCircleOutlined />}>有未保存的修改</Tag>}
                        <PermGuard resource="permission" action="edit"><Button size="small" icon={<ReloadOutlined />} onClick={() => { mutatePerms(); setPermDirty(false) }}>重置</Button></PermGuard>
                        <PermGuard resource="permission" action="edit"><Button size="small" type="primary" icon={<SaveOutlined />} loading={permSaving} disabled={!permDirty} onClick={handlePermSave}>保存权限</Button></PermGuard>
                      </div>
                    )}
                    <PermissionMatrix perms={isSuperAdmin ? buildAllPerms(matrix) : localPerms} onChange={handlePermChange} readonly={isSuperAdmin || !can('permission', 'edit')} searchText={matrixSearch} />
                  </div>
                )},
                { key: 'users', label: <span><UserOutlined /> 关联用户 <Badge count={selectedRole.userCount} size="small" style={{ marginLeft: 4 }} /></span>, children: (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <Input prefix={<SearchOutlined />} placeholder="搜索用户姓名或邮箱" value={userSearch} onChange={e => setUserSearch(e.target.value)} style={{ width: 200 }} allowClear size="small" />
                      <Select size="small" value={userStatusFilter} onChange={v => setUserStatusFilter(v as any)} style={{ width: 120 }}
                        options={[{ label: '状态: 全部', value: 'all' }, { label: '已启用', value: 'active' }, { label: '已停用', value: 'disabled' }]} />
                      <div style={{ flex: 1 }} />
                      <PermGuard resource="roles" action="edit"><Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setAssignOpen(true); setAssignUserIds([]) }}>分配用户</Button></PermGuard>
                    </div>
                    {filteredRoleUsers.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联用户" /> : (
                      <List size="small" dataSource={filteredRoleUsers} renderItem={(u: any) => (
                        <List.Item extra={<Space>
                          <span style={{ fontSize: 12, color: '#8C8C8C' }}>{u.lastLoginAt ? `最近登录 ${u.lastLoginAt}` : '未登录'}</span>
                          <PermGuard resource="roles" action="edit">
                            {u.protected ? (
                              <Tooltip title="系统默认管理员的超级管理员角色不可移除">
                                <Button size="small" type="link" disabled>移出</Button>
                              </Tooltip>
                            ) : (
                              <Popconfirm title={`确定将 ${u.username} 移出该角色？`} description="移出后用户仅失去该角色的权限，其他角色和独立权限保留" onConfirm={() => handleRemoveUser(u.id)}>
                                <Button size="small" type="link" danger>移出</Button>
                              </Popconfirm>
                            )}
                          </PermGuard>
                        </Space>}>
                          <List.Item.Meta
                            avatar={<Avatar size={32} src={u.avatarUrl || undefined} style={{ background: '#E6F1FB', color: '#185FA5', fontWeight: 600 }}>{!u.avatarUrl ? userInitial(u.username) : null}</Avatar>}
                            title={<span>{u.username}{u.status === 'active' ? <Tag color="success" style={{ fontSize: 10, marginLeft: 6 }}>已启用</Tag> : <Tag color="error" style={{ fontSize: 10, marginLeft: 6 }}>已停用</Tag>}</span>}
                            description={<span style={{ fontSize: 12 }}>{u.email}</span>} />
                        </List.Item>
                      )} />
                    )}
                    <div style={{ marginTop: 12, fontSize: 12, color: '#8C8C8C' }}>共 {selectedRole.userCount ?? 0} 人{filteredRoleUsers.length !== (roleUsers as any[]).length ? `，当前筛选显示 ${filteredRoleUsers.length} 人` : ''}</div>
                  </div>
                )},
                { key: 'info', label: <span><InfoCircleOutlined /> 基本信息</span>, children: (
                  <div style={{ maxWidth: 500, padding: '12px 0' }}>
                    {[{ label: '角色名称', value: selectedRole.displayName }, { label: '角色标识', value: selectedRole.name, mono: true }, { label: '描述', value: selectedRole.description || '—' }].map(item => (
                      <div key={item.label} style={{ marginBottom: 20 }}><div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 4 }}>{item.label}</div><div style={{ fontSize: 14, fontWeight: 500, fontFamily: (item as any).mono ? 'monospace' : undefined }}>{item.value}</div></div>
                    ))}
                    <div style={{ display: 'flex', gap: 40 }}>
                      <div><div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 4 }}>创建人</div><div style={{ fontSize: 14 }}>{selectedRole.creatorName || (selectedRole.isBuiltin ? '系统内置' : '—')}</div></div>
                      <div><div style={{ fontSize: 12, color: '#8C8C8C', marginBottom: 4 }}>创建时间</div><div style={{ fontSize: 14 }}>{selectedRole.createdAt}</div></div>
                    </div>
                  </div>
                )},
                { key: 'history', label: <span><HistoryOutlined /> 变更记录</span>, children: (
                  <div style={{ padding: '8px 0' }}>
                    {roleHistory.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无变更记录" /> : (
                      <Timeline items={roleHistory.map((h: any) => ({ color: getHistoryColor(h.action), children: (<div><div style={{ fontWeight: 500, fontSize: 13 }}>{h.action}</div><div style={{ fontSize: 12, color: '#8C8C8C' }}>{h.userEmail} · {h.createdAt}</div></div>) }))} />
                    )}
                  </div>
                )},
              ]} />
            </Card>
          </>) : (
            <Card className="atop-content-card atop-admin-empty-card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}><Empty description="选择一个角色查看详情" /></Card>
          )}
        </div>
      </div>

      {/* Create Modal */}
      <Modal title="新建角色" open={createOpen} onCancel={() => { setCreateOpen(false); createForm.resetFields() }} width={560}
        footer={<Space><Button onClick={() => { setCreateOpen(false); createForm.resetFields() }}>取消</Button><Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>创建角色</Button></Space>}>
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="displayName" label="角色名称" style={{ flex: 1 }} rules={[{ required: true, message: '请输入角色名称' }, maxLenRule('displayName', '角色名称')]}><Input placeholder="例如：测试工程师" {...inputLimit('displayName')} /></Form.Item>
            <Form.Item name="name" label="角色标识" style={{ flex: 1 }} rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9_]*$/, message: '英文字母/下划线' }, maxLenRule('roleKey', '角色标识')]} extra="英文字母/下划线，创建后不可修改"><Input placeholder="QA_ENGINEER" {...inputLimit('roleKey')} /></Form.Item>
          </div>
          <Form.Item name="description" label="角色描述" rules={[maxLenRule('description', '角色描述')]}><Input.TextArea rows={3} placeholder="简要描述该角色的职责与可见范围" {...inputLimit('description')} /></Form.Item>
        </Form>
        <ColorCardPicker value={selectedColor} onChange={setSelectedColor} label={createForm.getFieldValue('displayName') || 'A'} />
        <PresetPicker options={buildPresets()} value={selectedPreset} onChange={setSelectedPreset} />
      </Modal>

      {/* Edit Modal */}
      <Modal title={`编辑角色 · ${selectedRole?.displayName}`} open={editOpen} onCancel={() => setEditOpen(false)} onOk={handleEdit} okText="保存" width={480}>
        <Form form={editForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="角色标识"><Input disabled value={selectedRole?.name} /></Form.Item>
          <Form.Item name="displayName" label="角色名称" rules={[{ required: true }, maxLenRule('displayName', '角色名称')]}><Input {...inputLimit('displayName')} /></Form.Item>
          <Form.Item name="description" label="描述" rules={[maxLenRule('description', '描述')]}><Input.TextArea rows={3} {...inputLimit('description')} /></Form.Item>
        </Form>
      </Modal>

      {/* Clone Modal */}
      <Modal title={<span><CopyOutlined /> 克隆角色</span>} open={cloneOpen} onCancel={() => { setCloneOpen(false); cloneForm.resetFields() }} width={560}
        footer={<Space><Button onClick={() => { setCloneOpen(false); cloneForm.resetFields() }}>取消</Button><Button type="primary" icon={<PlusOutlined />} onClick={handleClone}>克隆并保存</Button></Space>}>
        <Form form={cloneForm} layout="vertical" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="displayName" label="角色名称" style={{ flex: 1 }} rules={[{ required: true }, maxLenRule('displayName', '角色名称')]}><Input {...inputLimit('displayName')} /></Form.Item>
            <Form.Item name="name" label="角色标识" style={{ flex: 1 }} rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9_]*$/, message: '英文字母/下划线' }, maxLenRule('roleKey', '角色标识')]} extra="创建后不可修改"><Input {...inputLimit('roleKey')} /></Form.Item>
          </div>
          <Form.Item name="description" label="角色描述" rules={[maxLenRule('description', '角色描述')]}><Input.TextArea rows={2} {...inputLimit('description')} /></Form.Item>
        </Form>
        <ColorCardPicker value={cloneColor} onChange={setCloneColor} label={cloneForm.getFieldValue('displayName') || selectedRole?.displayName?.charAt(0) || 'A'} />
        <PresetPicker options={buildPresets(selectedRole ? { name: selectedRole.displayName, perms: localPerms } : undefined)} value={clonePreset} onChange={setClonePreset} />
      </Modal>

      {/* Assign Users Modal */}
      <Modal title="分配用户" open={assignOpen} onCancel={() => { setAssignOpen(false); setAssignUserIds([]) }} width={520}
        footer={<Space><Button onClick={() => { setAssignOpen(false); setAssignUserIds([]) }}>取消</Button><Button type="primary" icon={<PlusOutlined />} disabled={assignUserIds.length === 0} onClick={handleAssignUsers}>分配 {assignUserIds.length > 0 ? `(${assignUserIds.length})` : ''}</Button></Space>}>
        <div style={{ marginBottom: 12, fontSize: 13, color: '#5F5E5A' }}>选择要分配到「{selectedRole?.displayName}」角色的用户：</div>
        <Select mode="multiple" placeholder="搜索并选择用户" value={assignUserIds} onChange={setAssignUserIds} style={{ width: '100%' }} showSearch optionFilterProp="label" maxTagCount={5}
          options={assignableUsers.map((u: any) => ({ label: `${u.username} (${u.email})`, value: u.id }))} />
        <div style={{ marginTop: 8, fontSize: 12, color: '#8C8C8C' }}>可选用户 {assignableUsers.length} 人（已排除当前角色用户和已停用用户）</div>
      </Modal>
    </div>
  )
}
