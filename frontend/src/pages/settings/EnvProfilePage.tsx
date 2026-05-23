import { useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  Button, Table, Tag, Space, Drawer, Form, Input, Select,
  Switch, Popconfirm, Tooltip, Modal, Alert, Badge, Divider,
  message,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  DeploymentUnitOutlined, SyncOutlined, CheckCircleOutlined,
  CloseCircleOutlined, ClockCircleOutlined, WarningOutlined,
} from '@ant-design/icons'
import client from '@/api/client'
import PageHeader from '@/components/common/PageHeader'
import { PermGuard } from '@/hooks/usePermission'
import { useTableLayout } from '@/hooks/useTableLayout'
import { fmtDatetime } from '@/utils/format'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

const SWR_KEY = '/env-profiles'

interface Profile {
  id: string
  name: string
  project: string
  agentLabel: string
  deployScript: string
  checkCmd: string
  scriptHash: string
  autoDeploy: boolean
  description: string
  createdAt: string
}

interface NodeRow {
  nodeId: string
  nodeLabel: string
  online: boolean
  record?: {
    id: string
    status: string
    deployHash: string
    deployedAt?: string
    lastOutput?: string
  }
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  pending:  { color: 'default',  icon: <ClockCircleOutlined />,   label: '待部署' },
  running:  { color: 'processing', icon: <SyncOutlined spin />,   label: '部署中' },
  success:  { color: 'success',  icon: <CheckCircleOutlined />,   label: '已部署' },
  failed:   { color: 'error',    icon: <CloseCircleOutlined />,   label: '失败' },
  outdated: { color: 'warning',  icon: <WarningOutlined />,       label: '需更新' },
}

function StatusTag({ status }: { status?: string }) {
  const s = status ?? 'pending'
  const cfg = STATUS_CONFIG[s] ?? STATUS_CONFIG.pending
  return <Tag color={cfg.color} icon={cfg.icon}>{cfg.label}</Tag>
}

export default function EnvProfilePage() {
  const { data, isLoading } = useSWR(SWR_KEY,
    () => client.get('/env-profiles').then(r => r.data.data?.items ?? []))
  const profiles: Profile[] = data ?? []

  const [drawerOpen, setDrawerOpen]   = useState(false)
  const [editing, setEditing]         = useState<Profile | null>(null)
  const [saving, setSaving]           = useState(false)
  const [nodesOpen, setNodesOpen]     = useState(false)
  const [selProfile, setSelProfile]   = useState<Profile | null>(null)
  const [deploying, setDeploying]     = useState(false)
  const [form] = Form.useForm()
  const { tableProps } = useTableLayout({ offsetY: 320 })

  const nodesSWRKey = selProfile ? [`/env-profiles/${selProfile.id}/nodes`] : null
  const { data: nodesData, mutate: mutateNodes } = useSWR(
    nodesSWRKey,
    () => client.get(`/env-profiles/${selProfile!.id}/nodes`).then(r => r.data.data)
  )
  const nodes: NodeRow[]   = nodesData?.items ?? []
  const profileDetail      = nodesData?.profile ?? selProfile

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ autoDeploy: false })
    setDrawerOpen(true)
  }

  const openEdit = (p: Profile) => {
    setEditing(p)
    form.setFieldsValue({ ...p })
    setDrawerOpen(true)
  }

  const handleSave = async () => {
    const vals = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await client.put(`/env-profiles/${editing.id}`, vals)
        message.success('已更新')
      } else {
        await client.post('/env-profiles', vals)
        message.success('已创建')
      }
      globalMutate(SWR_KEY)
      setDrawerOpen(false)
    } catch { /* handled */ } finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    await client.delete(`/env-profiles/${id}`)
    message.success('已删除')
    globalMutate(SWR_KEY)
  }

  const openNodes = (p: Profile) => {
    setSelProfile(p)
    setNodesOpen(true)
  }

  const handleDeploy = async (nodeIds?: string[]) => {
    if (!selProfile) return
    setDeploying(true)
    try {
      const payload = nodeIds ? { nodeIds } : { all: true }
      const r = await client.post(`/env-profiles/${selProfile.id}/deploy`, payload)
      message.success(r.data.data?.message ?? '部署任务已创建')
      mutateNodes()
    } catch { /* handled */ } finally { setDeploying(false) }
  }

  const needDeploy = nodes.filter(n => !n.record || n.record.status !== 'success')
  const outdated   = nodes.filter(n => n.record?.status === 'outdated')

  const cols = [
    {
      title: '配置名称', dataIndex: 'name',
      render: (v: string, r: Profile) => (
        <div>
          <div style={{ fontWeight: 600 }}>{v}</div>
          <div style={{ fontSize: 11, color: '#9C9A92' }}>{r.description}</div>
        </div>
      ),
    },
    { title: '项目', dataIndex: 'project', render: (v: string) => <Tag>{v}</Tag> },
    { title: 'Agent 标签', dataIndex: 'agentLabel',
      render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '自动部署', dataIndex: 'autoDeploy',
      render: (v: boolean) => v
        ? <Tag color="blue">自动</Tag>
        : <Tag color="default">手动确认</Tag> },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, r: Profile) => (
        <Space>
          <Tooltip title="查看机器状态">
            <Button size="small" icon={<DeploymentUnitOutlined />}
              onClick={() => openNodes(r)}>机器状态</Button>
          </Tooltip>
          <PermGuard resource="env_profile" action="edit"><Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} /></PermGuard>
          <Popconfirm title="确认删除？同时清除部署记录" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const nodeCols = [
    {
      title: '机器节点', dataIndex: 'nodeId',
      render: (v: string, r: NodeRow) => (
        <Space>
          <Badge status={r.online ? 'success' : 'default'} />
          <code style={{ fontSize: 11 }}>{v}</code>
          {!r.online && <Tag color="default" style={{ fontSize: 10 }}>离线</Tag>}
        </Space>
      ),
    },
    {
      title: '部署状态',
      render: (_: unknown, r: NodeRow) => <StatusTag status={r.record?.status} />,
    },
    {
      title: '最后部署时间', dataIndex: ['record', 'deployedAt'],
      render: (v?: string) => v ? fmtDatetime(v) : '—',
    },
    {
      title: '操作',
      render: (_: unknown, r: NodeRow) => {
        const status = r.record?.status
        const needRedeploy = !status || status === 'failed' || status === 'outdated' || status === 'pending'
        return needRedeploy ? (
          <Button size="small" loading={deploying}
            onClick={() => handleDeploy([r.nodeId])}>
            {status === 'outdated' ? '重新部署' : '部署'}
          </Button>
        ) : (
          <Button size="small" onClick={() => handleDeploy([r.nodeId])}>重新部署</Button>
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader
        title="环境部署管理"
        subtitle="配置各 Agent 标签的环境初始化脚本，追踪每台机器的部署状态"
        extra={
          <PermGuard resource="env_profile" action="create"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建配置
          </Button></PermGuard>
        }
      />

      <Table {...tableProps} rowKey="id" columns={cols} dataSource={profiles}
        loading={isLoading} />

      {/* Edit Drawer */}
      <Drawer
        title={editing ? '编辑部署配置' : '新建部署配置'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={600}
        maskClosable={false}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="配置名称" rules={[{ required: true }, maxLenRule('name', '配置名称')]}>
            <Input placeholder="如：V3 Ubuntu 基础环境" {...inputLimit('name')} />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="project" label="所属项目" rules={[{ required: true }, maxLenRule('project', '所属项目')]}>
              <Input placeholder="V3_SOFTWARE" {...inputLimit('project')} />
            </Form.Item>
            <Form.Item name="agentLabel" label="Agent 标签" rules={[{ required: true }, maxLenRule('agentLabel', 'Agent 标签')]}>
              <Input placeholder="v3-ubuntu-gpu" {...inputLimit('agentLabel')} />
            </Form.Item>
          </div>
          <Form.Item name="description" label="描述（可选）" rules={[maxLenRule('description', '描述')]}>
            <Input placeholder="简要说明此配置的用途" {...inputLimit('description')} />
          </Form.Item>
          <Form.Item name="deployScript" label="部署脚本（Shell）"
            rules={[maxLenRule('script', '部署脚本')]}
            extra="脚本内容发生变化时，已部署的机器状态将标记为「需更新」">
            <Input.TextArea
              rows={8}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder={'#!/bin/bash\n# 环境初始化脚本\napt-get update\napt-get install -y python3 python3-pip\npip3 install pytest'}
              {...inputLimit('script')}
            />
          </Form.Item>
          <Form.Item name="checkCmd" label="校验命令（可选）"
            rules={[maxLenRule('command', '校验命令')]}
            extra="部署完成后执行，返回 0 表示成功">
            <Input placeholder="python3 --version && pytest --version" {...inputLimit('command')} />
          </Form.Item>
          <Form.Item name="autoDeploy" label="新机器自动部署" valuePropName="checked"
            extra="开启后，检测到未部署的新机器时自动触发部署；关闭则只发送告警">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Nodes Modal */}
      <Modal
        title={
          <Space>
            <DeploymentUnitOutlined />
            <span>{selProfile?.name} · 机器部署状态</span>
            <Tag>{selProfile?.agentLabel}</Tag>
          </Space>
        }
        open={nodesOpen}
        onCancel={() => setNodesOpen(false)}
        width={800}
        footer={
          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <div style={{ fontSize: 12, color: '#9C9A92' }}>
              共 {nodes.length} 台机器
              {outdated.length > 0 && (
                <span style={{ color: '#854F0B', marginLeft: 8 }}>
                  · {outdated.length} 台需更新
                </span>
              )}
            </div>
            <Space>
              <Button icon={<SyncOutlined />} onClick={() => mutateNodes()}>刷新</Button>
              {needDeploy.length > 0 && (
                <Button type="primary" loading={deploying}
                  onClick={() => handleDeploy()}>
                  一键部署全部 ({needDeploy.length} 台)
                </Button>
              )}
            </Space>
          </Space>
        }
      >
        {outdated.length > 0 && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ marginBottom: 12, fontSize: 12 }}
            message={`${outdated.length} 台机器的部署脚本已更新，需要重新部署以同步最新环境`}
          />
        )}
        {profileDetail?.scriptHash && (
          <div style={{ fontSize: 11, color: '#9C9A92', marginBottom: 8 }}>
            当前脚本 Hash：<code>{profileDetail.scriptHash?.slice(0, 8)}</code>
          </div>
        )}
        <Table
          rowKey="nodeId"
          columns={nodeCols}
          dataSource={nodes}
          size="small"
          pagination={false}
        />
      </Modal>
    </div>
  )
}
