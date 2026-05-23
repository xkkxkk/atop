import { Fragment } from 'react'
import { CheckOutlined, CloseOutlined, LoadingOutlined, MinusOutlined, LinkOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { fmtDuration } from '@/utils/format'
import type { StageInfo } from '@/types'

const STAGE_NAMES: StageInfo['name'][] = ['Set Up', 'Exec Cmd', 'Report Status', 'Tear Down']

interface StageViewProps {
  stages: StageInfo[]
  jenkinsBaseUrl?: string
  jenkinsBuildId?: number
}

function StageBox({ stage, stageName, jenkinsBaseUrl, jenkinsBuildId }: {
  stage: StageInfo | undefined
  stageName: StageInfo['name']
  jenkinsBaseUrl?: string
  jenkinsBuildId?: number
}) {
  if (!stage) {
    return (
      <div style={{
        flex: 1, textAlign: 'center', padding: '8px 6px',
        border: '0.5px solid rgba(0,0,0,0.10)', borderRadius: 8, opacity: 0.4,
      }}>
        <div style={{ fontSize: 14, color: '#9C9A92' }}><MinusOutlined /></div>
        <div style={{ fontSize: 11, fontWeight: 500, marginTop: 2, color: '#9C9A92' }}>{stageName}</div>
      </div>
    )
  }

  const isOk = stage.status === 'SUCCESS'
  const isFail = stage.status === 'FAILED'
  const isRun = stage.status === 'IN_PROGRESS'
  const isSkip = stage.status === 'NOT_EXECUTED'

  const bgColor = isOk ? '#E1F5EE' : isFail ? '#FCEBEB' : isRun ? '#E6F1FB' : 'transparent'
  const bdColor = isOk ? '#9FE1CB' : isFail ? '#F7C1C1' : isRun ? '#B5D4F4' : 'rgba(0,0,0,0.10)'
  const iconColor = isOk ? '#0F6E56' : isFail ? '#DC2626' : isRun ? '#2563EB' : '#9C9A92'
  const textColor = isOk ? '#085041' : isFail ? '#791F1F' : isRun ? '#185FA5' : '#9C9A92'

  const logUrl = stage.logHref && jenkinsBaseUrl
    ? `${jenkinsBaseUrl.replace('/console', '')}/execution/node/${stage.id}/log`
    : (jenkinsBuildId && jenkinsBaseUrl ? jenkinsBaseUrl : undefined)

  const box = (
    <div style={{
      flex: 1, textAlign: 'center', padding: '8px 6px',
      background: bgColor,
      border: `0.5px solid ${bdColor}`,
      borderRadius: 8,
      cursor: logUrl && (isOk || isFail) ? 'pointer' : 'default',
      opacity: isSkip ? 0.45 : 1,
      transition: 'opacity .15s',
      minWidth: 0,
    }}
      onClick={() => logUrl && (isOk || isFail) && window.open(logUrl, '_blank')}
    >
      <div style={{ fontSize: 15, color: iconColor, lineHeight: 1.2 }}>
        {isOk && <CheckOutlined />}
        {isFail && <CloseOutlined />}
        {isRun && <LoadingOutlined />}
        {isSkip && <MinusOutlined />}
      </div>
      <div style={{ fontSize: 11, fontWeight: 500, margin: '2px 0 1px', color: textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {stage.name}
      </div>
      <div style={{ fontSize: 10, color: textColor, opacity: 0.7 }}>
        {isSkip ? '未执行' : fmtDuration(stage.durationMs)}
      </div>
      {logUrl && (isOk || isFail) && (
        <div style={{ fontSize: 10, color: iconColor, marginTop: 2 }}>
          <LinkOutlined /> 查看日志
        </div>
      )}
    </div>
  )

  if (logUrl && (isOk || isFail)) {
    return <Tooltip title="点击查看该 Stage 的 Jenkins 日志">{box}</Tooltip>
  }
  return box
}

export default function StageView({ stages, jenkinsBaseUrl, jenkinsBuildId }: StageViewProps) {
  const stageMap = new Map(stages.map((s) => [s.name, s]))

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, margin: '12px 0' }}>
      {STAGE_NAMES.map((name, idx) => (
        <Fragment key={name}>
          <StageBox
            stage={stageMap.get(name)}
            stageName={name}
            jenkinsBaseUrl={jenkinsBaseUrl}
            jenkinsBuildId={jenkinsBuildId}
          />
          {idx < STAGE_NAMES.length - 1 && (
            <div style={{ padding: '0 4px', color: 'rgba(0,0,0,0.18)', fontSize: 12, flexShrink: 0 }}>
              {'>'}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}
