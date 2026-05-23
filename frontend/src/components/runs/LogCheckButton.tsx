import { useState, useEffect } from 'react'
import { Button, Tooltip, message } from 'antd'
import { SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { taskRunApi } from '@/api/pipelines'
import type { LogStatus } from '@/types'

interface Props {
  taskRunId: string
  logStatus: LogStatus
  logCheckedAt?: string
  jenkinsBuildUrl?: string
  onStatusChange?: (status: LogStatus) => void
}

export default function LogCheckButton({
  taskRunId, logStatus, logCheckedAt, jenkinsBuildUrl, onStatusChange,
}: Props) {
  const [status, setStatus]   = useState<LogStatus>(logStatus)
  const [checking, setChecking] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [cooldown])

  const handleCheck = async () => {
    if (checking || cooldown > 0) return
    setChecking(true)
    try {
      const res = await taskRunApi.checkLog(taskRunId)
      setStatus(res.logStatus)
      onStatusChange?.(res.logStatus)
      message.success(res.logStatus === 'available' ? '日志存在' : '日志已被 Jenkins 清理')
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { cooldownSeconds?: number } } }
      if (e?.response?.status === 429) {
        const sec = e.response.data?.cooldownSeconds ?? 300
        setCooldown(sec)
        message.warning(`检测冷却中，${sec} 秒后可再次检测`)
      }
    } finally {
      setChecking(false)
    }
  }

  const StatusIcon = () => {
    if (status === 'available') return <CheckCircleOutlined style={{ color: '#0F6E56' }} />
    if (status === 'expired')   return <CloseCircleOutlined style={{ color: '#DC2626' }} />
    return <QuestionCircleOutlined style={{ color: '#9C9A92' }} />
  }

  const statusLabel = {
    available: '日志存在',
    expired:   '已清理',
    unknown:   '未检测',
  }[status]

  const checkedTooltip = logCheckedAt ? `检测于 ${logCheckedAt}` : undefined

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* Log link or expired indicator */}
      {status === 'available' && jenkinsBuildUrl && (
        <Tooltip title={checkedTooltip}>
          <a href={jenkinsBuildUrl} target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: '#185FA5' }}>
            查看日志 ↗
          </a>
        </Tooltip>
      )}
      {status === 'expired' && (
        <Tooltip title={checkedTooltip}>
          <span style={{ fontSize: 11, color: '#A32D2D' }}><StatusIcon /> 日志已清理</span>
        </Tooltip>
      )}
      {status === 'unknown' && jenkinsBuildUrl && (
        <Tooltip title="日志状态未知，点击尝试打开">
          <a href={jenkinsBuildUrl} target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: '#9C9A92' }}>
            尝试查看 ↗
          </a>
        </Tooltip>
      )}

      {/* Check button */}
      <Tooltip title={cooldown > 0 ? `冷却中（${cooldown}s 后可用）` : '检测日志是否仍在 Jenkins 中存在'}>
        <Button
          size="small"
          icon={<SyncOutlined spin={checking} />}
          loading={checking}
          disabled={cooldown > 0}
          onClick={handleCheck}
          style={{ fontSize: 11 }}
        >
          {cooldown > 0 ? `${cooldown}s` : '检测'}
        </Button>
      </Tooltip>
    </div>
  )
}
