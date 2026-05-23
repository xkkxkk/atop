import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import duration from 'dayjs/plugin/duration'

dayjs.extend(relativeTime)
dayjs.extend(duration)

export function fmtDatetime(iso?: string | null): string {
  if (!iso) return '—'
  return dayjs(iso).format('YYYY-MM-DD HH:mm:ss')
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return '—'
  return dayjs(iso).fromNow()
}

export function fmtDuration(ms?: number | null): string {
  if (!ms) return '—'
  const d = dayjs.duration(ms)
  const h = Math.floor(d.asHours())
  const m = d.minutes()
  const s = d.seconds()
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function fmtRate(rate?: number | null): string {
  if (rate == null) return '—'
  return `${rate.toFixed(1)}%`
}

export function rateColor(rate?: number | null): string {
  if (rate == null) return '#9C9A92'
  if (rate >= 90) return '#0F6E56'
  if (rate >= 70) return '#854F0B'
  return '#A32D2D'
}

export function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return `${str.slice(0, max)}…`
}
