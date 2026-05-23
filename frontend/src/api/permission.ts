import client from './client'

export interface PermissionMap {
  [resource: string]: {
    [action: string]: boolean
  }
}

export interface MatrixItem {
  resource: string
  label: string
  actions: { action: string; label: string }[]
}

export interface RoleItem {
  id: string
  name: string
  displayName: string
  description: string
  isBuiltin: boolean
  status?: 'active' | 'disabled'
  userCount: number
  createdBy: string
  creatorName: string
  createdAt: string
}

export interface RoleLite {
  name: string
  displayName: string
  isBuiltin: boolean
  status?: 'active' | 'disabled'
}

export const permissionApi = {
  // Get full resource/action matrix (for UI building)
  getMatrix: () =>
    client.get<{ data: MatrixItem[] }>('/permissions/matrix')
      .then(r => r.data.data),

  // Get current user's effective permissions
  getMyPermissions: () =>
    client.get<{ data: PermissionMap }>('/permissions/my')
      .then(r => r.data.data),

  // Role permissions
  getRolePermissions: (role: string) =>
    client.get<{ data: PermissionMap }>(`/permissions/roles/${role}`)
      .then(r => r.data.data),

  updateRolePermissions: (role: string, perms: PermissionMap) =>
    client.put(`/permissions/roles/${role}`, perms).then(r => r.data),

  // User overrides
  getUserPermissionOverrides: (userId: string) =>
    client.get<{ data: PermissionMap }>(`/permissions/users/${userId}`)
      .then(r => r.data.data),

  updateUserPermissionOverrides: (userId: string, perms: PermissionMap) =>
    client.put(`/permissions/users/${userId}`, perms).then(r => r.data),

  // Lightweight roles list for dropdowns (no extra permission needed)
  listRoles: () =>
    client.get<{ data: RoleLite[] }>('/permissions/roles-list')
      .then(r => r.data.data),
}

// Role management API
export const roleApi = {
  list: () =>
    client.get<{ data: RoleItem[] }>('/admin/roles')
      .then(r => r.data.data),

  get: (id: string) =>
    client.get<{ data: RoleItem }>(`/admin/roles/${id}`)
      .then(r => r.data.data),

  create: (data: { name: string; displayName: string; description?: string; perms?: PermissionMap; cloneFrom?: string }) =>
    client.post('/admin/roles', data).then(r => r.data),

  update: (id: string, data: { displayName?: string; description?: string }) =>
    client.put(`/admin/roles/${id}`, data).then(r => r.data),

  toggleStatus: (id: string, status: 'active' | 'disabled') =>
    client.put(`/admin/roles/${id}/status`, { status }).then(r => r.data),

  delete: (id: string) =>
    client.delete(`/admin/roles/${id}`).then(r => r.data),

  getUsers: (roleName: string) =>
    client.get<{ data: any[] }>(`/admin/roles/by-name/${roleName}/users`)
      .then(r => r.data.data ?? []),

  assignUsers: (roleName: string, userIds: string[]) =>
    client.post(`/admin/roles/by-name/${roleName}/users`, { userIds }).then(r => r.data),

  removeUser: (roleName: string, userId: string) =>
    client.delete(`/admin/roles/by-name/${roleName}/users/${userId}`).then(r => r.data),

  getHistory: (id: string) =>
    client.get<{ data: any[] }>(`/admin/roles/${id}/history`)
      .then(r => r.data.data ?? []),
}

// Resource and action labels (mirrors backend)
export const RESOURCE_LABELS: Record<string, string> = {
  pipeline:         '流水线',
  jenkins:          'Jenkins 实例',
  vars:             '公共变量池',
  dimensions:       '数据字典',
  users:            '用户管理',
  roles:            '角色管理',
  audit:            '审计日志',
  notification_rule:'通知规则',
  permission:       '权限配置',
  cleanup:          '数据清理',
}

export const ACTION_LABELS: Record<string, string> = {
  view:       '查看',
  create:     '新建',
  edit:       '编辑',
  delete:     '删除',
  trigger:    '触发运行',
  import:     '批量导入',
  clone:      '复制',
  ping:       '连通测试',
  sync:       '同步节点',
  reset_pwd:  '重置密码',
  disable:    '禁用/启用',
  fullscreen: '全屏大盘',
}

// Dynamic role colors — builtin roles get fixed colors, custom roles cycle through palette
const BUILTIN_ROLE_COLORS: Record<string, { color: string; bg: string }> = {
  super_admin:     { color: '#791F1F', bg: '#FCEBEB' },
  project_manager: { color: '#085041', bg: '#E1F5EE' },
  member:          { color: '#185FA5', bg: '#E6F1FB' },
  viewer:          { color: '#9C9A92', bg: '#F5F5F4' },
}

const CUSTOM_PALETTE = [
  { color: '#6B3FA0', bg: '#F0E6FF' },
  { color: '#A0522D', bg: '#FFF0E6' },
  { color: '#2E7D32', bg: '#E8F5E9' },
  { color: '#0277BD', bg: '#E1F5FE' },
  { color: '#C2185B', bg: '#FCE4EC' },
]

export function getRoleColor(roleName: string): { color: string; bg: string } {
  if (BUILTIN_ROLE_COLORS[roleName]) return BUILTIN_ROLE_COLORS[roleName]
  let hash = 0
  for (let i = 0; i < roleName.length; i++) {
    hash = ((hash << 5) - hash) + roleName.charCodeAt(i)
  }
  return CUSTOM_PALETTE[Math.abs(hash) % CUSTOM_PALETTE.length]
}

// Legacy compat
export const ROLES = [
  { value: 'super_admin',     label: '超级管理员', color: '#791F1F', bg: '#FCEBEB' },
  { value: 'project_manager', label: '项目负责人', color: '#085041', bg: '#E1F5EE' },
  { value: 'member',          label: '普通成员',   color: '#185FA5', bg: '#E6F1FB' },
  { value: 'viewer',          label: '访客',       color: '#9C9A92', bg: '#F5F5F4' },
]
