import { useState, useRef, useCallback } from 'react'
import useSWR from 'swr'
import {
  Card, Table, Button, Space, Tag, Select, Input, Modal,
  Form, Segmented, message, Drawer, Tooltip, Typography,
  Alert, Popconfirm, Badge,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined,
  CodeOutlined, RollbackOutlined, CopyOutlined,
  ExclamationCircleOutlined, CheckCircleOutlined, WarningOutlined,
} from '@ant-design/icons'
import MonacoEditor, { loader } from '@monaco-editor/react'
import { libsApi, type SharedLib, type SharedLibVersion } from '@/api/libs'
import { useModalForm } from '@/hooks/useModalForm'
import { useDimensions } from '@/hooks/useDimensions'
import { useTableLayout } from '@/hooks/useTableLayout'
import PageHeader from '@/components/common/PageHeader'
import { PermGuard } from '@/hooks/usePermission'
import RelativeTimeText from '@/components/common/RelativeTimeText'
import EmptyState from '@/components/common/EmptyState'
import { showConfirm } from '@/components/common/ConfirmModal'
import ResizableDrawer from '@/components/common/ResizableDrawer'
import { checkSyntax, type SyntaxError as ScriptError } from '@/utils/syntaxChecker'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'
import { configureMonaco } from '@/utils/monacoConfig'

const { Text } = Typography

configureMonaco()

const LANG_TEMPLATES: Record<'sh' | 'py', string> = {
  sh: `#!/usr/bin/env bash
# -------------------------------------------------------
# Function library template
# -------------------------------------------------------
set -euo pipefail

example_function() {
  local arg1="$1"
  echo "[INFO] Called with: \${arg1}"
}
`,
  py: `#!/usr/bin/env python3
# -------------------------------------------------------
# Function library template
# -------------------------------------------------------

def example_function(arg: str) -> str:
    """Example function"""
    print(f"[INFO] Called with: {arg}")
    return arg
`,
}

const LANG_CFG: Record<string, { color: string; label: string }> = {
  sh: { color: '#085041', label: 'Shell' },
  py: { color: '#185FA5', label: 'Python 3.x' },
}

const SCOPE_CFG: Record<string, { color: string; label: string }> = {
  system: { color: 'purple', label: '系统级' },
  project: { color: 'blue', label: '项目级' },
}

function VersionDrawer({
  lib,
  open,
  onClose,
}: { lib: SharedLib | null; open: boolean; onClose: () => void }) {
  const [previewVersion, setPreviewVersion] = useState<SharedLibVersion | null>(null)

  const { data: versions = [], mutate } = useSWR(
    lib && open ? ['lib-versions', lib.id] : null,
    () => libsApi.listVersions(lib!.id),
    { revalidateOnFocus: false },
  )

  const handleRollback = (version: SharedLibVersion) => {
    showConfirm({
      title: `回滚到 v${version.version}？`,
      content: '回滚后将创建一个新的版本快照，当前内容不会丢失。',
      okText: '确认回滚',
      okDanger: false,
      onOk: async () => {
        await libsApi.rollback(lib!.id, version.version)
        message.success(`已回滚到 v${version.version}，当前版本已更新`)
        mutate()
        onClose()
      },
    })
  }

  return (
    <Drawer
      title={`版本历史 · ${lib?.name ?? ''}`}
      open={open}
      onClose={onClose}
      width={900}
      extra={lib ? <Tag>当前版本 v{lib.version}</Tag> : null}
    >
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ width: 200, flexShrink: 0 }}>
          {versions.map((version) => (
            <div
              key={version.id}
              onClick={() => setPreviewVersion(version)}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                background: previewVersion?.id === version.id ? '#E6F1FB' : 'transparent',
                marginBottom: 4,
              }}
            >
              <div style={{ fontWeight: 500, fontSize: 14 }}>v{version.version}</div>
              <RelativeTimeText value={version.createdAt} style={{ fontSize: 12, color: '#9C9A92' }} />
              <div style={{ fontSize: 12, color: '#5F5E5A' }}>{version.changedBy}</div>
            </div>
          ))}
          {versions.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9C9A92', padding: 40 }}>暂无版本记录</div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {previewVersion ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Tag color="blue">v{previewVersion.version}</Tag>
                <RelativeTimeText value={previewVersion.createdAt} style={{ fontSize: 12, color: '#9C9A92' }} />
                {previewVersion.version !== lib?.version && (
                  <Button
                    size="small"
                    icon={<RollbackOutlined />}
                    onClick={() => handleRollback(previewVersion)}
                    style={{ marginLeft: 'auto' }}
                  >
                    回滚到此版本
                  </Button>
                )}
              </div>

              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                <MonacoEditor
                  height={500}
                  language={lib?.lang === 'sh' ? 'shell' : 'python'}
                  value={previewVersion.content}
                  options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on' }}
                  theme="vs"
                />
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: 60, color: '#9C9A92' }}>点击左侧版本查看内容</div>
          )}
        </div>
      </div>
    </Drawer>
  )
}

export default function LibsPage() {
  const [scopeFilter, setScopeFilter] = useState<'all' | 'system' | 'project'>('all')
  const [langFilter, setLangFilter] = useState<string>('')
  const [keyword, setKeyword] = useState('')
  const [editingLib, setEditingLib] = useState<SharedLib | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [histLib, setHistLib] = useState<SharedLib | null>(null)
  const [histOpen, setHistOpen] = useState(false)
  const [syntaxErrors, setSyntaxErrors] = useState<ScriptError[]>([])
  const editorRef = useRef<any>(null)

  const [form] = Form.useForm()
  const { cancelWithConfirm, markClean } = useModalForm(form)
  const { projectOptions } = useDimensions()
  const { tableProps } = useTableLayout({ offsetY: 290 })

  const { data: libs = [], isLoading, mutate } = useSWR(
    ['shared-libs', scopeFilter, langFilter, keyword],
    () => libsApi.list({
      scope: scopeFilter === 'all' ? undefined : scopeFilter,
      lang: langFilter || undefined,
      keyword: keyword || undefined,
    }),
    { revalidateOnFocus: false },
  )

  const runSyntaxCheck = useCallback((code: string, lang: 'sh' | 'py') => {
    const errors = checkSyntax(code, lang)
    setSyntaxErrors(errors)

    if (editorRef.current) {
      loader.init().then((monaco) => {
        const model = editorRef.current?.getModel()
        if (!model) return

        monaco.editor.setModelMarkers(model, 'atop-lint', errors.map((error) => ({
          startLineNumber: error.line,
          startColumn: error.col,
          endLineNumber: error.line,
          endColumn: error.col + 30,
          message: error.message,
          severity: error.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        })))
      })
    }
  }, [])

  const handleEditorMount = useCallback((editor: any) => {
    editorRef.current = editor
  }, [])

  const closeDrawer = () => {
    setDrawerOpen(false)
    form.resetFields()
    setSyntaxErrors([])
    editorRef.current = null
  }

  const openCreate = () => {
    setEditingLib(null)
    form.resetFields()
    const initial = { lang: 'sh', scope: 'system', content: LANG_TEMPLATES.sh }
    form.setFieldsValue(initial)
    markClean(initial)
    setSyntaxErrors([])
    setDrawerOpen(true)
  }

  const openEdit = (lib: SharedLib) => {
    setEditingLib(lib)
    const initial = {
      name: lib.name,
      description: lib.description,
      lang: lib.lang,
      scope: lib.scope,
      projectId: lib.projectId,
      content: lib.content,
    }
    form.setFieldsValue(initial)
    markClean(initial)
    setSyntaxErrors([])
    setDrawerOpen(true)
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    const errCount = syntaxErrors.filter((error) => error.severity === 'error').length

    if (errCount > 0) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '脚本存在语法错误',
          icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
          content: `检测到 ${errCount} 个错误，保存后脚本可能无法正常运行，确认仍要保存吗？`,
          okText: '仍要保存',
          cancelText: '返回修改',
          okButtonProps: { danger: true },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })

      if (!confirmed) return
    }

    try {
      if (editingLib) {
        await libsApi.update(editingLib.id, { content: values.content, description: values.description })
        message.success('保存成功，已生成新的版本快照')
      } else {
        await libsApi.create(values)
        message.success('函数库已创建')
      }

      closeDrawer()
      mutate()
    } catch {
      // handled by axios interceptor
    }
  }

  const handleDelete = (lib: SharedLib) => {
    showConfirm({
      title: `确认删除函数库「${lib.name}」？`,
      content: '删除后，引用此函数库的脚本将无法继续加载。',
      onOk: async () => {
        await libsApi.delete(lib.id)
        message.success('已删除')
        mutate()
      },
    })
  }

  const cols = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: SharedLib) => (
        <Space direction="vertical" size={0}>
          <Space>
            <Text strong style={{ fontSize: 13 }}>{name}</Text>
            <Tag color={LANG_CFG[row.lang]?.color} style={{ fontSize: 11 }}>
              {LANG_CFG[row.lang]?.label ?? row.lang}
            </Tag>
          </Space>
          {row.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>{row.description}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '作用域',
      key: 'scope',
      width: 130,
      render: (_: unknown, row: SharedLib) => (
        <Space direction="vertical" size={0}>
          <Tag color={SCOPE_CFG[row.scope]?.color}>{SCOPE_CFG[row.scope]?.label ?? row.scope}</Tag>
          {row.scope === 'project' && row.projectId && (
            <Text type="secondary" style={{ fontSize: 11 }}>{row.projectId}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 70,
      render: (version: number) => <Badge count={`v${version}`} color="#6366f1" />,
    },
    {
      title: '最后更新',
      key: 'updated',
      width: 130,
      render: (_: unknown, row: SharedLib) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}><RelativeTimeText value={row.updatedAt} /></Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{row.updatedBy}</Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, row: SharedLib) => (
        <Space size={4}>
          <PermGuard resource="libs" action="edit">
            <Tooltip title="编辑内容">
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
            </Tooltip>
          </PermGuard>

          <Tooltip title="版本历史">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => { setHistLib(row); setHistOpen(true) }} />
          </Tooltip>

          <Tooltip title="复制名称">
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(row.name)
                message.success('已复制')
              }}
            />
          </Tooltip>

          <PermGuard resource="libs" action="delete">
            <Popconfirm
              title="确认删除？"
              description="引用此函数库的脚本将无法运行"
              onConfirm={() => handleDelete(row)}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </PermGuard>
        </Space>
      ),
    },
  ]

  const errCount = syntaxErrors.filter((error) => error.severity === 'error').length
  const warnCount = syntaxErrors.filter((error) => error.severity === 'warning').length

  return (
    <div>
      <PageHeader
        title="公共函数库"
        subtitle="维护可复用的 Shell / Python 脚本，测试集可通过 source 或 import 引用，执行时平台会自动注入。"
        extra={(
          <PermGuard resource="libs" action="create">
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建函数库</Button>
          </PermGuard>
        )}
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <Segmented
          value={scopeFilter}
          onChange={(value) => setScopeFilter(value as 'all' | 'system' | 'project')}
          options={[
            { label: '全部', value: 'all' },
            { label: '系统级', value: 'system' },
            { label: '项目级', value: 'project' },
          ]}
        />

        <Select
          placeholder="语言"
          style={{ width: 130 }}
          allowClear
          value={langFilter || undefined}
          options={[
            { label: 'Shell (.sh)', value: 'sh' },
            { label: 'Python 3.x (.py)', value: 'py' },
          ]}
          onChange={(value) => setLangFilter(value ?? '')}
        />

        <Input.Search
          placeholder="搜索名称或描述..."
          style={{ width: 220 }}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onSearch={setKeyword}
          allowClear
        />

        <Button onClick={() => { setScopeFilter('all'); setLangFilter(''); setKeyword('') }}>重置</Button>
      </div>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {!isLoading && libs.length === 0 ? (
          <EmptyState description="暂无函数库" createLabel="新建函数库" onCreate={openCreate} resource="libs" />
        ) : (
          <Table
            {...tableProps}
            dataSource={libs}
            columns={cols}
            rowKey="id"
            size="middle"
            loading={isLoading}
            pagination={false}
          />
        )}
      </Card>

      <Card size="small" style={{ marginTop: 12 }} title={<span style={{ fontSize: 14 }}>使用说明</span>}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: '#085041' }}>Shell 引用方式</div>
            <pre style={{ background: '#F6F8FA', borderRadius: 8, padding: '10px 14px', fontSize: 12, margin: 0 }}>{`# 在 Set Up 或 Exec Cmd 脚本中
source \${LIB_DIR}/sh/system/download_utils.sh
download_with_retry "\${URL}" /tmp/pkg.tar.gz 3`}</pre>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: '#185FA5' }}>Python 引用方式</div>
            <pre style={{ background: '#F6F8FA', borderRadius: 8, padding: '10px 14px', fontSize: 12, margin: 0 }}>{`# PYTHONPATH 由平台自动注入
from system.report_utils import format_error_summary
result = parse_test_result("/workspace/logs/test.log")
print(f"Pass rate: {result['pass_rate']}%")`}</pre>
          </div>
        </div>
      </Card>

      <ResizableDrawer
        title={(
          <Space>
            <CodeOutlined style={{ color: '#2563EB' }} />
            {editingLib ? `编辑函数库 · ${editingLib.name}` : '新建函数库'}
          </Space>
        )}
        open={drawerOpen}
        onClose={() => cancelWithConfirm(closeDrawer)}
        maskClosable={false}
        defaultWidth={860}
        minWidth={520}
        maxWidth={1400}
        extra={(
          <Space>
            <Tooltip title="拖动左侧边缘可调整宽度">
              <span style={{ fontSize: 11, color: '#9C9A92', cursor: 'default', userSelect: 'none' }}>
                可拖拽调宽
              </span>
            </Tooltip>
            <Button onClick={() => cancelWithConfirm(closeDrawer)}>取消</Button>
            <Button type="primary" onClick={handleSave}>保存</Button>
          </Space>
        )}
        styles={{ body: { padding: '16px 24px', overflowY: 'auto' } }}
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item
              name="name"
              label="函数库名称"
              rules={[
                { required: true, message: '函数库名称为必填项' },
                { pattern: /^[a-z][a-z0-9_-]*$/, message: '仅支持小写字母、数字、下划线和连字符，且必须以字母开头' },
                maxLenRule('name', '函数库名称'),
              ]}
            >
              <Input placeholder="例如：download_utils" disabled={!!editingLib} {...inputLimit('name')} />
            </Form.Item>

            <Form.Item name="description" label="描述" rules={[maxLenRule('description', '描述')]}>
              <Input placeholder="简要说明函数库的用途" {...inputLimit('description')} />
            </Form.Item>

            <Form.Item name="lang" label="语言" rules={[{ required: true }]}>
              <Select
                disabled={!!editingLib}
                options={[
                  { label: 'Shell (.sh)', value: 'sh' },
                  { label: 'Python 3.x (.py)', value: 'py' },
                ]}
                onChange={(newLang: 'sh' | 'py') => {
                  const currentContent = form.getFieldValue('content') as string | undefined
                  const prevLang: 'sh' | 'py' = newLang === 'sh' ? 'py' : 'sh'
                  const hasCustomContent = currentContent
                    && currentContent.trim() !== ''
                    && currentContent.trim() !== LANG_TEMPLATES[prevLang].trim()

                  if (hasCustomContent) {
                    Modal.confirm({
                      title: '切换语言将替换脚本内容',
                      content: '当前已经存在自定义内容。切换语言后，将替换为新语言的默认模板，确认继续吗？',
                      okText: '确认切换',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => {
                        form.setFieldValue('content', LANG_TEMPLATES[newLang])
                        setSyntaxErrors([])
                      },
                      onCancel: () => setTimeout(() => form.setFieldValue('lang', prevLang), 0),
                    })
                  } else {
                    form.setFieldValue('content', LANG_TEMPLATES[newLang])
                    setSyntaxErrors([])
                  }
                }}
              />
            </Form.Item>

            <Form.Item
              name="scope"
              label="作用域"
              rules={[{ required: true }]}
              extra={editingLib
                ? <span style={{ fontSize: 11, color: '#9C9A92' }}>作用域创建后不可修改，如需变更请新建函数库</span>
                : undefined}
            >
              <Select
                disabled={!!editingLib}
                options={[
                  { label: '系统级（所有项目可用，仅管理员维护）', value: 'system' },
                  { label: '项目级（仅指定项目可用）', value: 'project' },
                ]}
              />
            </Form.Item>

            <Form.Item noStyle shouldUpdate={(prev, current) => prev.scope !== current.scope}>
              {({ getFieldValue }) => getFieldValue('scope') === 'project' && (
                <Form.Item name="projectId" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
                  <Select options={projectOptions} disabled={!!editingLib} />
                </Form.Item>
              )}
            </Form.Item>
          </div>

          <Form.Item
            name="content"
            label={(
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span>脚本内容</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
                  {errCount > 0 && (
                    <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ fontSize: 11, margin: 0 }}>
                      {errCount} 个错误
                    </Tag>
                  )}
                  {warnCount > 0 && (
                    <Tag color="warning" icon={<WarningOutlined />} style={{ fontSize: 11, margin: 0 }}>
                      {warnCount} 个警告
                    </Tag>
                  )}
                  {syntaxErrors.length === 0 && !!form.getFieldValue('content') && (
                    <Tag color="success" icon={<CheckCircleOutlined />} style={{ fontSize: 11, margin: 0 }}>
                      语法检查通过
                    </Tag>
                  )}
                  <Button
                    size="small"
                    type="link"
                    style={{ fontSize: 11, padding: '0 4px', height: 20 }}
                    onClick={() => runSyntaxCheck(form.getFieldValue('content') || '', form.getFieldValue('lang') || 'sh')}
                  >
                    手动检查
                  </Button>
                </div>
              </div>
            )}
            rules={[
              { required: true, message: '脚本内容不能为空' },
              maxLenRule('script', '脚本内容'),
            ]}
          >
            <Form.Item noStyle shouldUpdate={(prev, current) => prev.lang !== current.lang}>
              {({ getFieldValue }) => (
                <div style={{
                  border: `1px solid ${errCount > 0 ? '#ff4d4f' : warnCount > 0 ? '#faad14' : 'rgba(0,0,0,0.12)'}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                  transition: 'border-color 0.2s',
                }}>
                  <MonacoEditor
                    height={460}
                    language={getFieldValue('lang') === 'sh' ? 'shell' : 'python'}
                    value={form.getFieldValue('content')}
                    onMount={handleEditorMount}
                    onChange={(value) => {
                      form.setFieldValue('content', value)
                      clearTimeout((window as any).__syntaxTimer)
                      ;(window as any).__syntaxTimer = setTimeout(() => {
                        runSyntaxCheck(value || '', form.getFieldValue('lang') || 'sh')
                      }, 800)
                    }}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: 'on',
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      renderWhitespace: 'selection',
                      bracketPairColorization: { enabled: true },
                      suggest: { showSnippets: true },
                      tabSize: 2,
                    }}
                    theme="vs"
                  />
                </div>
              )}
            </Form.Item>
          </Form.Item>

          {syntaxErrors.length > 0 && (
            <div style={{ marginTop: -8, marginBottom: 12 }}>
              <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8 }}>
                {syntaxErrors.map((error, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      padding: '6px 12px',
                      fontSize: 12,
                      borderBottom: index < syntaxErrors.length - 1 ? '1px solid #fafafa' : undefined,
                      background: error.severity === 'error' ? '#fff2f0' : '#fffbe6',
                    }}
                  >
                    {error.severity === 'error'
                      ? <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginTop: 1, flexShrink: 0 }} />
                      : <WarningOutlined style={{ color: '#faad14', marginTop: 1, flexShrink: 0 }} />}
                    <span style={{ color: '#9C9A92', flexShrink: 0, minWidth: 56 }}>第 {error.line} 行</span>
                    <span style={{ color: '#333' }}>{error.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {editingLib && (
            <Alert
              type="info"
              showIcon
              message="保存后会自动生成新的版本快照。历史版本可在“版本历史”中查看和回滚，最多保留 50 个版本。"
              style={{ fontSize: 13 }}
            />
          )}
        </Form>
      </ResizableDrawer>

      <VersionDrawer lib={histLib} open={histOpen} onClose={() => setHistOpen(false)} />
    </div>
  )
}
