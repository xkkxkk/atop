import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import {
  Card, Form, Input, Select, Switch, Button, Space, Tag, InputNumber,
  Divider, message, Spin, Tooltip, Radio, Modal, Tabs, Alert,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, CaretRightOutlined, SaveOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
import { testSetApi } from '@/api/testsets'
import { libsApi } from '@/api/libs'
import { dimensionApi } from '@/api/settings'
import { useDimensions } from '@/hooks/useDimensions'
import PageHeader from '@/components/common/PageHeader'
import PreviewJsonModal from '@/components/testsets/PreviewJsonModal'
import { showConfirm } from '@/components/common/ConfirmModal'
import { formSnapshot, hasFormChanged } from '@/utils/formDirty'
import type { TestSet, TestSetConfig, DockerMode } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

// ── Step card wrapper ─────────────────────────────────────────────────────
function StepCard({ step, title, badge, color = 'blue', children }: {
  step: number; title: string; badge: string
  color?: 'blue' | 'green' | 'gray'; children: React.ReactNode
}) {
  const cfgs = {
    blue:  { num: '#E6F1FB', numT: '#0C447C', tag: '#185FA5', tagBg: '#E6F1FB' },
    green: { num: '#E1F5EE', numT: '#085041', tag: '#0F6E56', tagBg: '#E1F5EE' },
    gray:  { num: '#F5F5F4', numT: '#5F5E5A', tag: '#5F5E5A', tagBg: '#F5F5F4' },
  }
  const c = cfgs[color]
  return (
    <Card size="small" style={{ marginBottom: 12 }} title={
      <Space size={8}>
        <div style={{ width: 24, height: 24, borderRadius: '50%', background: c.num, color: c.numT,
          fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {step}
        </div>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{title}</span>
        <Tag style={{ fontSize: 11, background: c.tagBg, color: c.tag, border: 'none' }}>{badge}</Tag>
      </Space>
    }>{children}</Card>
  )
}

// ── Download row ──────────────────────────────────────────────────────────
function DownloadRow({ name, remove }: { name: number; remove: () => void }) {
  const form = Form.useFormInstance()
  const repoType = Form.useWatch(['downloads', name, 'repoType'], form) ?? 'artifact'

  return (
    <div style={{ background: '#FAFAF9', borderRadius: 8, padding: '10px 12px', marginBottom: 8, border: '0.5px solid rgba(0,0,0,0.07)' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Form.Item name={[name, 'repoType']} style={{ margin: 0, minWidth: 140 }} initialValue="artifact">
          <Select size="small" options={[
            { label: 'Artifact 产物', value: 'artifact' },
            { label: 'curl 文件', value: 'curl_file' },
            { label: 'Git 仓库', value: 'git' },
            { label: '直接 URL', value: 'url' },
          ]} />
        </Form.Item>
        <Form.Item name={[name, 'source']} style={{ flex: 1, margin: 0 }} rules={[{ required: true, message: '来源必填' }, maxLenRule('url', '来源')]}>
          <Input size="small" placeholder={
            repoType === 'artifact' ? '产物路径，支持 ${tag}、${json_source}' :
            repoType === 'curl_file' ? '包含 URL 的文件路径' :
            repoType === 'git' ? 'ssh://git@gitlab.../repo.git' : 'https://...'
          } {...inputLimit('url')} />
        </Form.Item>
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={remove} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: repoType === 'artifact' ? '1fr 1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
        {repoType === 'artifact' && (
          <>
            <Form.Item name={[name, 'stage']} style={{ margin: 0 }} label={<span style={{ fontSize: 11 }}>Stage 名</span>} rules={[maxLenRule('stageName', 'Stage 名')]}>
              <Input size="small" placeholder="precheck_submit" {...inputLimit('stageName')} />
            </Form.Item>
            <Form.Item name={[name, 'sourceInfolder']} style={{ margin: 0 }} label={<span style={{ fontSize: 11 }}>子目录</span>} rules={[maxLenRule('path', '子目录')]}>
              <Input size="small" placeholder="last / ${tag}" {...inputLimit('path')} />
            </Form.Item>
          </>
        )}
        <Form.Item name={[name, 'destPath']} style={{ margin: 0 }} label={<span style={{ fontSize: 11 }}>目标路径</span>} rules={[{ required: true }, maxLenRule('path', '目标路径')]}>
          <Input size="small" placeholder="$workspace" {...inputLimit('path')} />
        </Form.Item>
        <Form.Item name={[name, 'cmd']} style={{ margin: 0 }} label={<span style={{ fontSize: 11 }}>下载后执行（解压等）</span>} rules={[maxLenRule('command', '下载后执行命令')]}>
          <Input size="small" placeholder="tar -xf xxx.tar --strip-components=1 -C $workspace/sdk/" {...inputLimit('command')} />
        </Form.Item>
      </div>
    </div>
  )
}

// ── Exec cmd block ────────────────────────────────────────────────────────
function ExecCmdBlock({ idx, remove, canRemove }: { idx: number; remove: () => void; canRemove: boolean }) {
  const form = Form.useFormInstance()
  const dockerMode: DockerMode = Form.useWatch(['execCmds', idx, 'dockerMode'], form) ?? 'internal'

  return (
    <div style={{ background: '#F7F8FF', borderRadius: 10, padding: '12px 14px', marginBottom: 10, border: '0.5px solid rgba(37,99,235,0.15)' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
        <Tag style={{ background: '#E6F1FB', color: '#185FA5', border: 'none', fontSize: 12 }}>
          命令 {idx + 1}
        </Tag>
        <Form.Item name={[idx, 'cmdLabel']} style={{ margin: 0, flex: 1 }} rules={[maxLenRule('name', '命令标签')]}>
          <Input size="small" placeholder="命令标签，如 run_test" {...inputLimit('name')} />
        </Form.Item>
        {canRemove && <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={remove} />}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#5F5E5A', fontWeight: 500, marginBottom: 6 }}>容器模式</div>
        <Form.Item name={[idx, 'dockerMode']} style={{ margin: 0 }} initialValue="internal">
          <Radio.Group size="small">
            <Radio.Button value="internal">内部镜像仓库</Radio.Button>
            <Radio.Button value="native">原生 Docker</Radio.Button>
            <Radio.Button value="none">不使用 Docker</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </div>

      {dockerMode === 'internal' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px', marginBottom: 8 }}>
            <Form.Item name={[idx, 'dockerRepoUrl']} label={<span style={{ fontSize: 12 }}>Docker 启动 Repo URL</span>} style={{ margin: 0 }} rules={[maxLenRule('url', 'Docker 启动 Repo URL')]}>
              <Input size="small" placeholder="ssh://git@gitlab.company.com/docker-scripts.git" {...inputLimit('url')} />
            </Form.Item>
            <Form.Item name={[idx, 'dockerStartScript']} label={<span style={{ fontSize: 12 }}>启动脚本路径（repo内）</span>} style={{ margin: 0 }} rules={[maxLenRule('path', '启动脚本路径')]}>
              <Input size="small" placeholder="scripts/start_docker.sh" {...inputLimit('path')} />
            </Form.Item>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Form.Item name={[idx, 'dockerImgReadfile']} label={<span style={{ fontSize: 12 }}>镜像列表文件（可选）</span>} style={{ margin: 0 }} rules={[maxLenRule('path', '镜像列表文件')]}>
              <Input size="small" placeholder="$workspace/sdk/ci_qa_images.txt" {...inputLimit('path')} />
            </Form.Item>
            <Form.Item name={[idx, 'dockerImgLabel']} label={<span style={{ fontSize: 12 }}>镜像 Label</span>} style={{ margin: 0 }} rules={[maxLenRule('dockerImage', '镜像 Label')]}>
              <Input size="small" placeholder="ubuntu_20_v3_cmodel_py310_test_docker" {...inputLimit('dockerImage')} />
            </Form.Item>
            <Form.Item name={[idx, 'dockerMount']} label={<span style={{ fontSize: 12 }}>挂载路径</span>} style={{ margin: 0 }} rules={[maxLenRule('dockerMount', '挂载路径')]}>
              <Input size="small" placeholder="$workspace:/workspace" {...inputLimit('dockerMount')} />
            </Form.Item>
          </div>
        </div>
      )}

      {dockerMode === 'native' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px', marginBottom: 10 }}>
          <Form.Item name={[idx, 'dockerImage']} label={<span style={{ fontSize: 12 }}>镜像地址</span>}
            rules={[{ required: dockerMode === 'native', message: '镜像地址必填' }, maxLenRule('dockerImage', '镜像地址')]} style={{ margin: 0 }}>
            <Input size="small" placeholder="registry.internal:5000/v3-test:latest" {...inputLimit('dockerImage')} />
          </Form.Item>
          <Form.Item name={[idx, 'dockerMount']} label={<span style={{ fontSize: 12 }}>挂载路径</span>} style={{ margin: 0 }} rules={[maxLenRule('dockerMount', '挂载路径')]}>
            <Input size="small" placeholder="/data/workspace:/workspace" {...inputLimit('dockerMount')} />
          </Form.Item>
        </div>
      )}

      <Divider style={{ margin: '8px 0', fontSize: 11 }}>环境变量</Divider>
      <Form.List name={[idx, 'envVars']}>
        {(fields, { add, remove: rmVar }) => (
          <>
            {fields.map(({ key, name }) => (
              <div key={key} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
                <Form.Item name={[name, 'key']}   style={{ flex: '0 0 130px', margin: 0 }} rules={[maxLenRule('variableKey', '环境变量名')]}>
                  <Input size="small" placeholder="SDK_DIR" {...inputLimit('variableKey')} />
                </Form.Item>
                <Form.Item name={[name, 'value']} style={{ flex: 1, margin: 0 }} rules={[maxLenRule('variableValue', '环境变量值')]}>
                  <Input size="small" placeholder="${workspace}/sdk" {...inputLimit('variableValue')} />
                </Form.Item>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => rmVar(name)} />
              </div>
            ))}
            <Button type="dashed" size="small" icon={<PlusOutlined />}
              onClick={() => add({ key: '', value: '' })}>添加变量</Button>
          </>
        )}
      </Form.List>

      <Divider style={{ margin: '8px 0', fontSize: 11 }}>执行命令</Divider>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px', marginBottom: 8 }}>
        <Form.Item name={[idx, 'cmdRundir']} label={<span style={{ fontSize: 12 }}>工作目录</span>} style={{ margin: 0 }} rules={[maxLenRule('path', '工作目录')]}>
          <Input size="small" placeholder="$workspace/sdk/" {...inputLimit('path')} />
        </Form.Item>
        <Form.Item name={[idx, 'runBash']} label={<span style={{ fontSize: 12 }}>入口脚本（可选）</span>} style={{ margin: 0 }} rules={[maxLenRule('runBash', '入口脚本')]}>
          <Input size="small" placeholder="bash.sh" {...inputLimit('runBash')} />
        </Form.Item>
      </div>
      <Form.Item name={[idx, 'cmd']} label={<span style={{ fontSize: 12 }}>命令</span>}
        rules={[{ required: true, message: '命令不能为空' }, maxLenRule('script', '命令')]} style={{ marginBottom: 8 }}>
        <Input.TextArea rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder="source ${workspace}/sdk/testenv.sh -uh && bash ./ci/run_test.sh" {...inputLimit('script')} />
      </Form.Item>
      <Form.Item name={[idx, 'failPolicy']} label={<span style={{ fontSize: 12 }}>失败策略</span>}
        initialValue="block" style={{ marginBottom: 0, maxWidth: 260 }}>
        <Select size="small" options={[
          { label: '失败阻断 (block)', value: 'block' },
          { label: '继续执行 (continue)', value: 'continue' },
          { label: '中止流水线 (abort)', value: 'abort' },
        ]} />
      </Form.Item>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function TestSetEditPage() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isNew    = !id
  const [form]   = Form.useForm()
  const initialSnapshotRef = useRef('')
  const [saving, setSaving] = useState(false)
  const [runModalOpen, setRunModalOpen] = useState(false)
  const [matchedPipelines, setMatchedPipelines] = useState<Array<{id:string;name:string}>>([])
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const [matchLoading, setMatchLoading] = useState(false)

  const openRunFromEdit = async () => {
    if (!id) return
    setRunModalOpen(true)
    setSelectedPipelineId('')
    setMatchLoading(true)
    try {
      const res = await testSetApi.matchPipelines([id])
      setMatchedPipelines(res.items)
      if (res.items.length === 1) setSelectedPipelineId(res.items[0].id)
    } catch { /* handled */ }
    finally { setMatchLoading(false) }
  }

  const { projectOptions, environmentOptions, productOptions } = useDimensions()

  const { data: allDims = [] } = useSWR(
    'dimension-dict-all', () => dimensionApi.list(), { revalidateOnFocus: false }
  )
  const osOptions      = allDims.filter(d => d.dimension === 'os').map(d => ({ label: d.displayName || d.value, value: d.value }))
  const runTypeOptions = allDims.filter(d => d.dimension === 'run_type').map(d => ({ label: d.displayName || d.value, value: d.value }))

  const { data: shLibs = [] } = useSWR('sh-libs', () => libsApi.list({ lang: 'sh' }), { revalidateOnFocus: false })
  const shLibOptions = shLibs.map(l => ({ label: `[${l.scope === 'system' ? '系统' : '项目'}] ${l.name}`, value: l.name }))

  const { data: existing, isLoading } = useSWR(
    id ? ['test-set', id] : null,
    () => testSetApi.get(id!),
    { revalidateOnFocus: false }
  )

  useEffect(() => {
    if (existing) {
      // Defensive: configJson may be null for legacy records
      const c = (existing.configJson ?? {}) as Partial<TestSetConfig>
      const setup = (c.setup ?? {}) as Partial<TestSetConfig['setup']>
      const teardown = (c.teardown ?? {}) as Partial<TestSetConfig['teardown']>
      const initialValues = {
        name: existing.name, project: existing.project, environment: existing.environment,
        product: existing.product, os: existing.os,
        runType: existing.runType, branch: existing.branch, tags: existing.tags ?? [],
        status: existing.status === 'enabled', unit: existing.unit,
        priority: existing.priority ?? 0, timeout: existing.timeout || undefined,
        stageNum: existing.stageNum ?? 1,
        agentLabel: existing.agentLabel,
        cpulock: existing.cpulock ?? false, cpulockScript: existing.cpulockScript,
        dependsOn: existing.dependsOn ?? [], skipOnDepFailure: existing.skipOnDepFailure ?? false,
        artifactOutput: existing.artifactOutput, artifactInput: existing.artifactInput,
        operatorName: existing.operatorName, operatorId: existing.operatorId,
        leaderName: existing.leaderName, leaderId: existing.leaderId,
        remark: existing.remark,
        downloads: setup.downloads ?? [{ repoType: 'artifact', source: '', destPath: '$workspace' }],
        preScript: setup.preScript ?? '',
        execCmds: c.execCmds ?? [{ cmdLabel: 'run_test', dockerMode: 'internal', envVars: [], cmd: '', failPolicy: 'block' }],
        cleanWorkspace: teardown.cleanWorkspace ?? true,
        keepArtifacts: (teardown.keepArtifacts ?? []).join('\n'),
        stopDocker: teardown.stopDocker ?? true,
        postScript: teardown.postScript ?? '',
        reports: c.reports ?? [],
      }
      form.setFieldsValue(initialValues)
      initialSnapshotRef.current = formSnapshot(initialValues)
    } else if (isNew) {
      const initialValues = {
        status: true, priority: 0, stageNum: 1, cpulock: false,
        dependsOn: [], skipOnDepFailure: false,
        cleanWorkspace: true, stopDocker: true,
        downloads: [{ repoType: 'artifact', source: '', destPath: '$workspace' }],
        execCmds: [{ cmdLabel: 'run_test', dockerMode: 'internal', envVars: [], cmd: '', failPolicy: 'block' }],
        reports: [],
      }
      form.setFieldsValue(initialValues)
      initialSnapshotRef.current = formSnapshot(initialValues)
    }
  }, [existing, isNew, form])

  // Navigation guard removed (useBlocker causes white screen in some react-router versions)

  const hasUnsavedChanges = () =>
    hasFormChanged(initialSnapshotRef.current, form.getFieldsValue(true))

  const handleCancel = () => {
    if (!hasUnsavedChanges()) {
      navigate('/test-sets')
      return
    }
    showConfirm({
      title: '确认离开？',
      content: '填写了内容但未保存，关闭后将丢失。',
      okText: '离开',
      onOk: () => navigate('/test-sets'),
    })
  }

  const handleSave = async () => {
    try {
      const v = await form.validateFields()
      setSaving(true)
      const payload: Partial<TestSet> = {
        name: v.name, project: v.project, environment: v.environment,
        product: v.product, os: v.os, runType: v.runType,
        branch: v.branch, tags: v.tags ?? [], status: v.status ? 'enabled' : 'disabled',
        agentLabel: v.agentLabel,
        unit: v.unit, priority: v.priority ?? 0, timeout: v.timeout || 0,
        stageNum: v.stageNum ?? 1,
        cpulock: v.cpulock ?? false, cpulockScript: v.cpulockScript,
        dependsOn: v.dependsOn ?? [], skipOnDepFailure: v.skipOnDepFailure ?? false,
        artifactOutput: v.artifactOutput, artifactInput: v.artifactInput,
        operatorName: v.operatorName, leaderName: v.leaderName,
        remark: v.remark,
        configJson: {
          setup: { downloads: v.downloads ?? [], preScript: v.preScript ?? '' },
          execCmds: v.execCmds ?? [],
          teardown: {
            cleanWorkspace: v.cleanWorkspace ?? true,
            keepArtifacts: (v.keepArtifacts ?? '').split('\n').filter(Boolean),
            stopDocker: v.stopDocker ?? true, postScript: v.postScript ?? '',
          },
          reports: v.reports ?? [],
        },
      }
      isNew ? await testSetApi.create(payload) : await testSetApi.update(id!, payload)
      message.success(isNew ? '创建成功' : '保存成功')
      navigate('/test-sets')
    } catch (err: unknown) {
      const e = err as { errorFields?: unknown }
      if (e.errorFields) message.warning('请检查表单填写是否完整')
    } finally { setSaving(false) }
  }

  if (!isNew && isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (!isNew && !isLoading && !existing) return (
    <div style={{ textAlign: 'center', padding: 80 }}>
      <div style={{ color: '#9C9A92', fontSize: 14 }}>测试集不存在或已被删除</div>
      <Button style={{ marginTop: 16 }} onClick={() => navigate('/test-sets')}>返回列表</Button>
    </div>
  )

  // forceRender ensures all tab fields are mounted and validated correctly
const tabItems = [
    {
      key: 'basic',
      forceRender: true, label: '基础信息',
      children: (
        <>
          <Card size="small" style={{ marginBottom: 12 }}
            title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>坐标 & 标识</span>}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item name="name" label="测试集名称" rules={[{ required: true, message: "测试集名称为必填项" }, maxLenRule('name', '测试集名称')]} style={{ gridColumn: '1/-1' }}>
                <Input placeholder="描述性名称" {...inputLimit('name')} />
              </Form.Item>
              <Form.Item name="project"     label="项目"         rules={[{ required: true, message: "项目为必填项" }]}><Select options={projectOptions} /></Form.Item>
              <Form.Item name="environment" label="环境"         rules={[{ required: true, message: "环境为必填项" }]}><Select options={environmentOptions} /></Form.Item>
              <Form.Item name="product"     label="产品形态"     rules={[{ required: true, message: "产品形态为必填项" }]}><Select options={productOptions} /></Form.Item>
              <Form.Item name="os"          label="系统（OS）"   ><Select options={osOptions} allowClear placeholder="操作系统（可选）" /></Form.Item>
              <Form.Item name="runType"     label="类型"         ><Select options={runTypeOptions} allowClear placeholder="daily / nightly / regression..." /></Form.Item>
              <Form.Item name="branch"      label="分支" rules={[maxLenRule('jobName', '分支')]}><Input placeholder="master / release / dev" {...inputLimit('jobName')} /></Form.Item>
              <Form.Item name="tags"        label="标签">
                <Select mode="tags" placeholder="输入后回车添加"
                  options={['smoke','p0','regression','nightly','daily'].map(t => ({ label: t, value: t }))} />
              </Form.Item>
              <Form.Item name="unit" label={<>单位 <Tooltip title="可选，仅展示用"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>}>
                <Input placeholder="case / suite" {...inputLimit('roleKey')} />
              </Form.Item>
              <Form.Item name="status" label="状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="禁用" />
              </Form.Item>
            </div>
          </Card>

          <Card size="small" style={{ marginBottom: 12 }}
            title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>调度配置</span>}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0 16px' }}>
              <Form.Item name="agentLabel" label={<>Agent 标签 <Tooltip title="测试集运行的机器标签，自动分发"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>} rules={[{ required: true }, maxLenRule('agentLabel', 'Agent 标签')]}>
                <Input placeholder="V3_CMODEL / cherry" {...inputLimit('agentLabel')} />
              </Form.Item>
              <Form.Item name="priority" label={<>优先级 <Tooltip title="数值越小越先执行，如 -2 比 0 先执行"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>}>
                <InputNumber placeholder="0" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="timeout" label={<>超时时间 <Tooltip title="测试执行超时时间（分钟），不填则不限制"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>}>
                <InputNumber placeholder="不限制" min={1} style={{ width: '100%' }} addonAfter="分钟" />
              </Form.Item>
              <Form.Item name="stageNum" label={<>分发机器数 <Tooltip title="=1 单机；>1 拆分为 N 组分发到 N 台机器"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>}>
                <InputNumber min={1} max={32} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="cpulock" label="CPU/GPU 锁频" valuePropName="checked">
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(p, c) => p.cpulock !== c.cpulock}>
                {({ getFieldValue }) => getFieldValue('cpulock') && (
                  <Form.Item name="cpulockScript" label="锁频脚本（公共函数库）" rules={[{ required: true }]}>
                    <Select options={shLibOptions} placeholder="选择 sh 类型函数库" />
                  </Form.Item>
                )}
              </Form.Item>
            </div>
          </Card>

          {/* 执行依赖 */}
          <Card size="small" style={{ marginBottom: 12 }}
            title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>执行依赖</span>}>
            <Form.Item name="dependsOn"
              label={<>依赖测试集 <Tooltip title="选择上游测试集名称，本测试集将等待所有依赖完成后再执行"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>}
              extra="留空表示无依赖，按 priority 顺序或直接并行执行"
            >
              <Select
                mode="tags"
                placeholder="输入或选择依赖的测试集名称"
                tokenSeparators={[',']}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => JSON.stringify(p.dependsOn) !== JSON.stringify(c.dependsOn)}>
              {({ getFieldValue }) => {
                const deps = getFieldValue('dependsOn') ?? []
                return deps.length > 0 ? (
                  <Form.Item name="skipOnDepFailure" label={
                    <>依赖失败时跳过 <Tooltip title="开启后，当任一上游测试集失败时自动跳过本测试集"><QuestionCircleOutlined style={{ color: '#9C9A92' }} /></Tooltip></>
                  } valuePropName="checked">
                    <Switch checkedChildren="跳过" unCheckedChildren="继续执行" />
                  </Form.Item>
                ) : null
              }}
            </Form.Item>
          </Card>

          <Card size="small" style={{ marginBottom: 12 }}
            title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>负责人</span>}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item name="operatorName" label="负责人" rules={[maxLenRule('username', '负责人')]}><Input placeholder="测试集负责人姓名" {...inputLimit('username')} /></Form.Item>
              <Form.Item name="leaderName"   label="上级负责人" rules={[maxLenRule('username', '上级负责人')]}><Input placeholder="可选" {...inputLimit('username')} /></Form.Item>
            </div>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="可选，填写测试集的备注信息" maxLength={500} showCount />
            </Form.Item>
          </Card>

          <Card size="small" title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>产物路径（JFrog）</span>}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item name="artifactOutput" label="输出路径" extra="注入为 ARTIFACT_OUTPUT" rules={[maxLenRule('artifactPath', '输出路径')]}>
                <Input placeholder="atop-artifacts/V2/nightly/output.tar.gz" {...inputLimit('artifactPath')} />
              </Form.Item>
              <Form.Item name="artifactInput" label="输入路径" extra="注入为 ARTIFACT_INPUT" rules={[maxLenRule('artifactPath', '输入路径')]}>
                <Input placeholder="atop-artifacts/V2/nightly/build.tar.gz" {...inputLimit('artifactPath')} />
              </Form.Item>
            </div>
          </Card>
        </>
      ),
    },
    {
      key: 'setup',
      forceRender: true, label: 'Set Up',
      children: (
        <StepCard step={1} title="Set Up" badge="前置准备" color="green">
          <Form.List name="downloads">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <DownloadRow key={key} name={name} remove={() => remove(name)} />
                ))}
                <Button type="dashed" icon={<PlusOutlined />} size="small"
                  onClick={() => add({ repoType: 'artifact', source: '', destPath: '$workspace' })}>
                  添加下载任务
                </Button>
              </>
            )}
          </Form.List>
          <Divider style={{ margin: '12px 0' }} />
          <Form.Item name="preScript" label="前置脚本（可选）" rules={[maxLenRule('script', '前置脚本')]}>
            <Input.TextArea rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder="#!/bin/bash&#10;# 下载和测试之前运行" {...inputLimit('script')} />
          </Form.Item>
        </StepCard>
      ),
    },
    {
      key: 'exec',
      forceRender: true, label: 'Exec Cmd',
      children: (
        <StepCard step={2} title="Exec Cmd" badge="执行测试" color="blue">
          <Form.List name="execCmds">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <ExecCmdBlock key={key} idx={name} remove={() => remove(name)} canRemove={fields.length > 1} />
                ))}
                <Button type="dashed" icon={<PlusOutlined />} size="small"
                  onClick={() => add({ cmdLabel: `exec_${fields.length + 1}`, dockerMode: 'internal', envVars: [], cmd: '', failPolicy: 'block' })}>
                  添加执行命令
                </Button>
              </>
            )}
          </Form.List>
        </StepCard>
      ),
    },
    {
      key: 'teardown',
      forceRender: true, label: 'Tear Down',
      children: (
        <StepCard step={3} title="Tear Down" badge="清理收尾" color="gray">
          <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
            <Form.Item name="cleanWorkspace" valuePropName="checked" style={{ margin: 0 }}>
              <Switch checkedChildren="清理工作区" unCheckedChildren="保留工作区" />
            </Form.Item>
            <Form.Item name="stopDocker" valuePropName="checked" style={{ margin: 0 }}>
              <Switch checkedChildren="停止 Docker" unCheckedChildren="保留容器" />
            </Form.Item>
          </div>
          <Form.Item name="keepArtifacts" label="保留产物路径（每行一条，支持 glob）" rules={[maxLenRule('variableValue', '保留产物路径')]}>
            <Input.TextArea rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder="**/results/*.xml&#10;**/logs/*.log" {...inputLimit('variableValue')} />
          </Form.Item>
          <Form.Item name="postScript" label="后置脚本（可选）" rules={[maxLenRule('script', '后置脚本')]}>
            <Input.TextArea rows={2} style={{ fontFamily: 'monospace', fontSize: 12 }} {...inputLimit('script')} />
          </Form.Item>
        </StepCard>
      ),
    },
    {
      key: 'report', label: '外部上报',
      children: (
        <Card size="small" title={<span style={{ fontSize: 14, fontWeight: 500, color: '#5F5E5A' }}>外部 CI 上报（可选）</span>}>
          <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 13 }}
            message="测试开始前或完成后，将结果上报给外部 CI 平台。支持自定义 URL、方法和 Body 模板（${STATUS}、${PASS_RATE}、${BUILD_URL} 等）。" />
          <Form.List name="reports">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <div key={key} style={{ background: '#FFFBF0', borderRadius: 8, padding: '10px 12px', marginBottom: 8, border: '0.5px solid rgba(186,117,23,0.2)' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <Form.Item name={[name, 'trigger']} style={{ margin: 0, minWidth: 130 }} initialValue="after">
                        <Select size="small" options={[
                          { label: '测试完成后', value: 'after' },
                          { label: '测试开始前', value: 'before' },
                          { label: '前后各一次', value: 'both' },
                        ]} />
                      </Form.Item>
                      <Form.Item name={[name, 'method']} style={{ margin: 0, minWidth: 80 }} initialValue="POST">
                        <Select size="small" options={[{ label: 'POST', value: 'POST' }, { label: 'GET', value: 'GET' }]} />
                      </Form.Item>
                      <Form.Item name={[name, 'url']} style={{ flex: 1, margin: 0 }}
                        rules={[{ required: true, message: 'URL 必填' }, { type: 'url' }, maxLenRule('url', '上报 URL')]}>
                        <Input size="small" placeholder="https://ci.company.com/api/report" {...inputLimit('url')} />
                      </Form.Item>
                      <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => remove(name)} />
                    </div>
                    <Form.Item name={[name, 'bodyTemplate']} label={<span style={{ fontSize: 11 }}>Body 模板</span>} style={{ margin: 0 }} rules={[maxLenRule('bodyTemplate', 'Body 模板')]}>
                      <Input.TextArea rows={2} style={{ fontFamily: 'monospace', fontSize: 11 }}
                        placeholder={'{"status":"${STATUS}","pass_rate":${PASS_RATE},"url":"${BUILD_URL}"}'} {...inputLimit('bodyTemplate')} />
                    </Form.Item>
                  </div>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} size="small"
                  onClick={() => add({ trigger: 'after', method: 'POST', url: '', bodyTemplate: '' })}>
                  添加上报目标
                </Button>
              </>
            )}
          </Form.List>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={isNew ? '新建测试集' : `编辑 · ${existing?.name ?? ''}`}
        extra={
          <Space>
            {!isNew && id && <PreviewJsonModal testSetId={id} testSetName={existing?.name ?? ''} />}
            {!isNew && (
              <Button icon={<CaretRightOutlined />} onClick={() => {
                // Check if form has been modified
                const hasChanges = existing && hasUnsavedChanges()
                if (hasChanges) {
                  Modal.confirm({
                    title: '检测到未保存的修改',
                    content: '是否保存修改后再运行？选择"不保存"将使用修改前的配置触发运行。',
                    okText: '保存并运行',
                    cancelText: '不保存直接运行',
                    onOk: async () => {
                      await handleSave()
                      openRunFromEdit()
                    },
                    onCancel: () => {
                      openRunFromEdit()
                    },
                  })
                } else {
                  openRunFromEdit()
                }
              }}>单独运行</Button>
            )}
            <Button onClick={handleCancel}>取消</Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              {isNew ? '创建' : '保存'}
            </Button>
          </Space>
        }
      />

      <Form form={form} layout="vertical">
        <Tabs items={tabItems} size="middle" />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button onClick={handleCancel}>取消</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
            {isNew ? '创建测试集' : '保存修改'}
          </Button>
        </div>
      </Form>

      {/* Pipeline selection modal for single run */}
      <Modal
        title="选择流水线运行"
        open={runModalOpen}
        onCancel={() => setRunModalOpen(false)}
        onOk={() => {
          if (!selectedPipelineId) { message.warning('请选择一个流水线'); return }
          setRunModalOpen(false)
          navigate(`/pipelines/${selectedPipelineId}/run?preselect=${id}`)
        }}
        okText="确认运行"
        okButtonProps={{ disabled: !selectedPipelineId }}
      >
        {matchLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : matchedPipelines.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#9C9A92', padding: 24 }}>
            没有匹配的测试流水线，请先创建一个测试流水线并绑定相同项目
          </div>
        ) : (
          <Select
            style={{ width: '100%' }}
            placeholder="选择流水线"
            value={selectedPipelineId || undefined}
            onChange={setSelectedPipelineId}
            options={matchedPipelines.map(p => ({ label: p.name, value: p.id }))}
          />
        )}
      </Modal>
    </div>
  )
}
