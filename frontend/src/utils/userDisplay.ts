const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEGACY_ID_RE = /^u\d+$/i

export function displayUserName(name?: string | null, raw?: string | null, fallback = '未知用户') {
  const displayName = name?.trim()
  if (displayName) return displayName

  const value = raw?.trim()
  if (!value) return fallback
  if (value === 'system') return '系统'
  if (UUID_RE.test(value) || LEGACY_ID_RE.test(value)) return '已删除用户'

  return value
}
