const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]'

const isEmptyValue = (value: unknown) => {
  if (value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return value === undefined || value === null
}

export const normalizeFormValue = (value: unknown): unknown => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(normalizeFormValue)
      .filter((item) => !isEmptyValue(item))
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const normalized = normalizeFormValue(value[key])
        if (!isEmptyValue(normalized)) acc[key] = normalized
        return acc
      }, {})
  }
  return value
}

export const formSnapshot = (value: unknown) =>
  JSON.stringify(normalizeFormValue(value))

export const hasFormChanged = (initialSnapshot: string, currentValue: unknown) =>
  formSnapshot(currentValue) !== initialSnapshot
