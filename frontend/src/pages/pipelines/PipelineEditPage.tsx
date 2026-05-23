import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { Form, Button, message, Spin, Tag } from 'antd'
import { SaveOutlined, CaretRightOutlined } from '@ant-design/icons'
import { pipelineApi } from '@/api/pipelines'
import { jenkinsApi } from '@/api/settings'
import { useDimensions } from '@/hooks/useDimensions'
import PageHeader from '@/components/common/PageHeader'
import DAGEditor, { validateDAGClient } from '@/components/pipeline/DAGEditor'
import { showConfirm } from '@/components/common/ConfirmModal'
import { formSnapshot, hasFormChanged } from '@/utils/formDirty'
import { getTriggerTypeMeta } from '@/utils/pipelineDag'
import type { PipelineDAGConfig, TriggerType } from '@/types'

const CRON_PRESETS = [
  { label: '每天 22:00', value: '0 22 * * *' },
  { label: '每天 08:00', value: '0 8 * * *' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每小时', value: '0 * * * *' },
  { label: '自定义', value: 'custom' },
]

export default function PipelineEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isNew = !id
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [triggerType, setTriggerType] = useState<string>('manual')
  const [cronPreset, setCronPreset] = useState('0 22 * * *')
  const [dagConfig, setDagConfig] = useState<PipelineDAGConfig>({ nodes: [], edges: [] })
  const dagConfigRef = useRef<PipelineDAGConfig>({ nodes: [], edges: [] })
  const initialSnapshotRef = useRef('')
  const cronExpr = Form.useWatch('cronExpr', form)
  const triggerMeta = getTriggerTypeMeta(triggerType, cronExpr)
  const {
    projectOptions,
    environmentOptions,
    productOptions,
    osOptions,
    runTypeOptions,
  } = useDimensions()

  const { data: jenkins = [] } = useSWR('jenkins-list', jenkinsApi.list)
  const jenkinsOptions = jenkins.map((item) => ({ label: item.name, value: item.id }))

  const { data: existing, isLoading } = useSWR(
    id ? ['pipeline', id] : null,
    () => pipelineApi.get(id!),
    { revalidateOnFocus: false },
  )

  useEffect(() => {
    if (existing) {
      const existingTriggerType = existing.triggerType || 'manual'
      setTriggerType(existingTriggerType)
      if (existingTriggerType === 'cron' && existing.cronExpr) {
        const matchedCronPreset = CRON_PRESETS.some(item => item.value === existing.cronExpr)
        setCronPreset(matchedCronPreset ? existing.cronExpr : 'custom')
      } else {
        setCronPreset('0 22 * * *')
      }
      let nextDagConfig = { nodes: [], edges: [] } as PipelineDAGConfig
      const rawDagConfig = existing.dagConfigJson
      if (rawDagConfig) {
        try {
          const parsed = typeof rawDagConfig === 'string' ? JSON.parse(rawDagConfig) : rawDagConfig
          nextDagConfig = {
            nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
            edges: Array.isArray(parsed?.edges) ? parsed.edges : [],
            designer: parsed?.designer,
          }
        } catch {
          nextDagConfig = { nodes: [], edges: [] }
        }
      }
      setDagConfig(nextDagConfig)
      dagConfigRef.current = nextDagConfig
      const initialValues = {
        name: existing.name,
        project: existing.project,
        environment: existing.environment,
        product: existing.product,
        os: existing.os,
        runType: existing.runType,
        triggerType: existingTriggerType,
        cronExpr: existing.cronExpr,
        jenkinsInstanceId: existing.jenkinsBindings?.[0]?.jenkinsInstanceId ?? '',
        jenkinsBindings: existing.jenkinsBindings ?? [],
        params: existing.params ?? [],
        defaultFilterType: 'all',
        defaultFailPolicy: 'block',
      }
      form.setFieldsValue(initialValues)
      initialSnapshotRef.current = formSnapshot({ form: initialValues, dagConfig: nextDagConfig })
      return
    }

    if (isNew) {
      setTriggerType('manual')
      setCronPreset('0 22 * * *')
      const initialValues = {
        triggerType: 'manual',
        defaultFilterType: 'all',
        defaultFailPolicy: 'block',
        jenkinsInstanceId: '',
        jenkinsBindings: [],
        params: [],
      }
      dagConfigRef.current = { nodes: [], edges: [] }
      form.setFieldsValue(initialValues)
      initialSnapshotRef.current = formSnapshot({ form: initialValues, dagConfig: { nodes: [], edges: [] } })
    }
  }, [existing, form, isNew])

  const handleDagConfigChange = (nextConfig: PipelineDAGConfig) => {
    dagConfigRef.current = nextConfig
    setDagConfig(nextConfig)
  }

  const hasUnsavedChanges = () => hasFormChanged(initialSnapshotRef.current, {
    form: form.getFieldsValue(true),
    dagConfig,
  })

  const handleCancel = () => {
    if (!hasUnsavedChanges()) {
      navigate('/pipelines')
      return
    }
    showConfirm({
      title: '确认离开？',
      content: '当前修改还没有保存，离开后会丢失。',
      okText: '离开',
      onOk: () => navigate('/pipelines'),
    })
  }

  const handleSave = async () => {
    try {
      await form.validateFields()
      const values = form.getFieldsValue(true)
      const optionalText = (value: unknown) => String(value ?? '').trim() || undefined
      const normalizedName = String(values.name ?? '').trim()
      const normalizedProject = String(values.project ?? '').trim()
      const normalizedJenkinsInstanceId = String(values.jenkinsInstanceId ?? '').trim()
      const triggerValue = String(values.triggerType || triggerType || 'manual')
      const effectiveTriggerType: TriggerType = ['manual', 'cron', 'webhook', 'child'].includes(triggerValue)
        ? triggerValue as TriggerType
        : 'manual'
      const normalizedCronExpr = effectiveTriggerType === 'cron' ? String(values.cronExpr ?? '').trim() : ''
      const latestDagConfig = dagConfigRef.current

      if (!normalizedName || !normalizedProject) {
        message.warning('请在画布属性里填写流水线名称和项目')
        return
      }
      if (!normalizedJenkinsInstanceId) {
        message.warning('请在画布属性里选择 Jenkins 实例')
        return
      }
      if ((latestDagConfig.nodes?.length ?? 0) === 0) {
        message.warning('请至少拖入一个运行组件，例如 Jenkins 组件')
        return
      }

      const dagError = validateDAGClient(latestDagConfig)
      if (dagError) {
        message.warning(dagError)
        return
      }

      const jenkinsBindings = [{
        jenkinsInstanceId: normalizedJenkinsInstanceId,
        jobName: '',
        matchProject: '',
        matchOs: '',
      }]

      setSaving(true)
      const payload = {
        name: normalizedName,
        project: normalizedProject,
        environment: optionalText(values.environment),
        product: optionalText(values.product),
        os: optionalText(values.os),
        runType: optionalText(values.runType),
        triggerType: effectiveTriggerType,
        cronExpr: normalizedCronExpr,
        jenkinsBindings,
        params: values.params ?? [],
        stageConfigJson: {},
        dagConfigJson: latestDagConfig,
      }

      if (isNew) {
        await pipelineApi.create(payload)
        message.success('流水线创建成功')
      } else {
        await pipelineApi.update(id!, payload)
        message.success('保存成功')
      }
      navigate('/pipelines')
    } catch (error: unknown) {
      const formError = error as { errorFields?: unknown }
      if (formError.errorFields) {
        message.warning('请检查表单填写')
        return
      }
      const apiError = error as { isAxiosError?: boolean; response?: { data?: { message?: string } }; message?: string }
      if (!apiError.isAxiosError) {
        message.error(apiError.message || `${isNew ? '创建' : '保存'}流水线失败，请稍后重试`)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!isNew && isLoading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
  }

  return (
    <div className="atop-page-shell atop-pipeline-edit-page">
      <PageHeader
        eyebrow="PIPELINE DESIGNER"
        title={isNew ? '新建流水线' : `编辑流水线 · ${existing?.name ?? ''}`}
        subtitle="配置基础维度、Jenkins Job 路由、触发方式和运行参数。保存入口固定在右下角，不再遮挡画布。"
      />

      <Form form={form} layout="vertical" className="atop-pipeline-edit-form">
        <DAGEditor
          pipelineId={id}
          value={dagConfig}
          onChange={handleDagConfigChange}
          form={form}
          jenkinsOptions={jenkinsOptions}
          projectOptions={projectOptions}
          environmentOptions={environmentOptions}
          productOptions={productOptions}
          osOptions={osOptions}
          runTypeOptions={runTypeOptions}
          triggerType={triggerType}
          setTriggerType={setTriggerType}
          cronPreset={cronPreset}
          setCronPreset={setCronPreset}
          cronPresets={CRON_PRESETS}
        />
      </Form>

      <div className="atop-action-dock">
        <div className="atop-action-dock-copy">
          <span>触发方式</span>
          <strong>{triggerMeta.label}</strong>
          <Tag className="atop-trigger-meta-tag" style={{ background: '#F5F5F4', color: triggerMeta.color, border: 'none' }}>
            {triggerMeta.description}
          </Tag>
        </div>
        <div className="atop-action-dock-actions">
          <Button onClick={handleCancel}>取消</Button>
          {!isNew && (
            <Button icon={<CaretRightOutlined />} onClick={() => navigate(`/pipelines/${id}/run`)}>
              触发运行
            </Button>
          )}
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
            {isNew ? '创建流水线' : '保存修改'}
          </Button>
        </div>
      </div>
    </div>
  )
}
