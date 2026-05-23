import { useState, useEffect } from 'react'
import {
  Card, Form, Input, Button, message, Avatar, Tag, Space,
  Alert, Switch, Divider, Tooltip, Upload,
} from 'antd'
import {
  LockOutlined, BellOutlined, SaveOutlined,
  MailOutlined, InfoCircleOutlined, NotificationOutlined,
  CameraOutlined, UploadOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/api/auth'
import { notificationApi, EVENT_LABELS, type NotificationPreference } from '@/api/notification'
import PageHeader from '@/components/common/PageHeader'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

const ROLE_LABELS: Record<string, string> = {
  super_admin:     '超级管理员',
  project_manager: '项目负责人',
  member:          '普通用户',
  viewer:          '访客',
}

export default function ProfilePage() {
  const user          = useAuthStore(s => s.user)
  const updateUser    = useAuthStore(s => s.updateUser)
  const [pwdForm]     = Form.useForm()
  const [savingPwd,  setSavingPwd]  = useState(false)
  const [savingNoti, setSavingNoti] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState<string>()
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>()
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [pref, setPref]             = useState<NotificationPreference>({
    inAppEnabled:   true,
    emailEnabled:   false,
    webhookEnabled: false,
    webhookUrl:     '',
    eventSwitches: {
      pipeline_complete: true,
      pipeline_failed:   true,
      pipeline_aborted:  true,
      user_disabled:     true,
      password_reset:    true,
    },
  })

  // Load notification preferences
  useEffect(() => {
    notificationApi.getPreference()
      .then(setPref)
      .catch(() => {/* use defaults */})
  }, [])

  useEffect(() => {
    return () => {
      if (avatarPreview?.startsWith('blob:')) URL.revokeObjectURL(avatarPreview)
    }
  }, [avatarPreview])

  const handleChangePwd = async () => {
    const values = await pwdForm.validateFields()
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的新密码不一致')
      return
    }
    setSavingPwd(true)
    try {
      await authApi.changePassword({
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      })
      message.success('密码修改成功')
      pwdForm.resetFields()
    } catch { /* handled */ }
    finally { setSavingPwd(false) }
  }

  const handleSaveNoti = async () => {
    setSavingNoti(true)
    try {
      const eventSwitches = { ...pref.eventSwitches }
      delete eventSwitches.task_failed
      await notificationApi.updatePreference({ ...pref, eventSwitches })
      message.success('通知偏好已保存')
    } catch { /* handled */ }
    finally { setSavingNoti(false) }
  }

  const initials = user?.username?.slice(0, 1).toUpperCase() ?? '?'
  const currentAvatarUrl = ((user as { avatarUrl?: string } | null)?.avatarUrl ?? '').trim()
  const visibleAvatarUrl = avatarPreview || currentAvatarUrl

  const buildAvatarDataURL = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        const size = 320
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('canvas unavailable'))
          return
        }
        const side = Math.min(image.width, image.height)
        const sx = (image.width - side) / 2
        const sy = (image.height - side) / 2
        ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size)
        resolve(canvas.toDataURL('image/webp', 0.82))
      }
      image.onerror = () => reject(new Error('avatar image decode failed'))
      image.src = String(reader.result || '')
    }
    reader.onerror = () => reject(new Error('avatar read failed'))
    reader.readAsDataURL(file)
  })

  const handleAvatarBeforeUpload = (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.warning('请选择图片格式的头像文件')
      return Upload.LIST_IGNORE
    }
    if (file.size > 2 * 1024 * 1024) {
      message.warning('头像文件建议不超过 2MB')
      return Upload.LIST_IGNORE
    }
    const previewUrl = URL.createObjectURL(file)
    setAvatarPreview((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return previewUrl
    })
    buildAvatarDataURL(file)
      .then(setAvatarDataUrl)
      .catch(() => {
        setAvatarDataUrl(undefined)
        message.error('头像读取失败，请重新选择')
      })
    message.success('头像已选择，保存后会同步到服务器')
    return false
  }

  const clearAvatarPreview = () => {
    setAvatarPreview((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return undefined
    })
    setAvatarDataUrl(undefined)
  }

  const handleSaveAvatar = async () => {
    if (!avatarDataUrl) return
    setSavingAvatar(true)
    try {
      const updated = await authApi.updateAvatar(avatarDataUrl)
      updateUser(updated)
      clearAvatarPreview()
      message.success('头像已更新')
    } catch { /* handled */ }
    finally { setSavingAvatar(false) }
  }

  const handleRemoveAvatar = async () => {
    setSavingAvatar(true)
    try {
      const updated = await authApi.updateAvatar('')
      updateUser(updated)
      clearAvatarPreview()
      message.success('头像已恢复默认')
    } catch { /* handled */ }
    finally { setSavingAvatar(false) }
  }

  const setEventSwitch = (event: string, val: boolean) =>
    setPref(p => ({ ...p, eventSwitches: { ...p.eventSwitches, [event]: val } }))

  return (
    <div className="atop-page-shell atop-page-shell-narrow">
      <PageHeader
        eyebrow="ACCOUNT CENTER"
        title="个人设置"
        subtitle="维护登录密码和通知偏好，让平台提醒与个人工作节奏保持一致。"
      />

      <section className="atop-profile-hero">
          <div className="atop-profile-avatar-wrap">
            <Avatar
              className="atop-profile-avatar"
              size={68}
              src={visibleAvatarUrl || undefined}
              style={{ background: '#E6F1FB', color: '#185FA5',
                fontSize: 24, fontWeight: 800, flexShrink: 0 }}
            >
              {!visibleAvatarUrl ? initials : null}
            </Avatar>
            <Upload accept="image/*" showUploadList={false} beforeUpload={handleAvatarBeforeUpload}>
              <Button
                className="atop-profile-avatar-action"
                type="primary"
                shape="circle"
                icon={<CameraOutlined />}
                aria-label="修改头像"
              />
            </Upload>
          </div>
          <div>
            <div className="atop-profile-name">{user?.username}</div>
            <div className="atop-profile-email">{user?.email}</div>
            <Tag style={{ background: '#FCEBEB', color: '#791F1F', border: 'none',
              fontSize: 12, fontWeight: 700, marginTop: 10 }}>
              {ROLE_LABELS[user?.role ?? ''] ?? user?.role}
            </Tag>
            <div className="atop-profile-avatar-tools">
              <Upload accept="image/*" showUploadList={false} beforeUpload={handleAvatarBeforeUpload}>
                <Button size="small" icon={<UploadOutlined />}>选择头像</Button>
              </Upload>
              <Button
                size="small"
                type="primary"
                loading={savingAvatar}
                disabled={!avatarDataUrl}
                onClick={handleSaveAvatar}
              >
                保存头像
              </Button>
              {avatarPreview && <Button size="small" type="link" onClick={clearAvatarPreview}>取消预览</Button>}
              {currentAvatarUrl && !avatarPreview && (
                <Button size="small" type="link" danger loading={savingAvatar} onClick={handleRemoveAvatar}>
                  恢复默认
                </Button>
              )}
            </div>
            <div className="atop-profile-avatar-note">
              支持 JPG、PNG、WebP 等图片格式，建议不超过 2MB；没有头像时继续显示姓名首字。
            </div>
          </div>
      </section>

      {/* Change password */}
      <Card className="atop-content-card" size="small" style={{ marginBottom: 16 }}
        title={<Space><LockOutlined /><span>修改密码</span></Space>}
        extra={
          <Button type="primary" ghost icon={<SaveOutlined />}
            loading={savingPwd} onClick={handleChangePwd}>
            保存
          </Button>
        }
      >
        <Alert type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
          message="密码要求：至少 8 位，包含大写字母、小写字母和数字" />
        <Form form={pwdForm} layout="vertical" style={{ maxWidth: 400 }}>
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }, maxLenRule('password', '当前密码')]}>
            <Input.Password prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
              placeholder="输入当前密码" {...inputLimit('password')} />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码"
            rules={[
              { required: true },
              { min: 8, message: '密码至少 8 位' },
              maxLenRule('password', '新密码'),
              {
                validator: (_, v) => {
                  if (!v) return Promise.resolve()
                  if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[0-9]/.test(v))
                    return Promise.reject('密码需包含大写字母、小写字母和数字')
                  return Promise.resolve()
                },
              },
            ]}>
            <Input.Password prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
              placeholder="至少 8 位" {...inputLimit('password')} />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码"
            rules={[{ required: true }, maxLenRule('password', '确认新密码')]}>
            <Input.Password prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
              placeholder="再次输入新密码" {...inputLimit('password')} />
          </Form.Item>
        </Form>
      </Card>

      {/* Notification preferences */}
      <Card className="atop-content-card" size="small"
        title={<Space><BellOutlined /><span>通知偏好</span></Space>}
        extra={
          <Button type="primary" ghost icon={<SaveOutlined />}
            loading={savingNoti} onClick={handleSaveNoti}>
            保存
          </Button>
        }
      >
        {/* Channels */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#5F5E5A', marginBottom: 12 }}>
            通知渠道
          </div>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div className="atop-channel-row">
              <div className="atop-channel-meta">
                <span className="atop-channel-icon"><NotificationOutlined /></span>
                <div>
                  <div className="atop-channel-title">站内消息</div>
                  <div className="atop-channel-desc">仅影响保存后的新通知，已收到消息仍会显示</div>
                </div>
              </div>
              <Switch checked={pref.inAppEnabled}
                onChange={v => setPref(p => ({ ...p, inAppEnabled: v }))}
                checkedChildren="开" unCheckedChildren="关" />
            </div>
            <Divider style={{ margin: '4px 0' }} />
            <div className="atop-channel-row">
              <div className="atop-channel-meta">
                <span className="atop-channel-icon"><MailOutlined /></span>
                <div>
                  <div className="atop-channel-title">邮件通知</div>
                  <div className="atop-channel-desc">发送到 {user?.email}</div>
                </div>
              </div>
              <Switch checked={pref.emailEnabled}
                onChange={v => setPref(p => ({ ...p, emailEnabled: v }))}
                checkedChildren="开" unCheckedChildren="关" />
            </div>
          </Space>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        {/* Event switches */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#5F5E5A', marginBottom: 12 }}>
            通知事件
            <Tooltip title="事件开关只影响之后产生的新通知，不会隐藏已经发送的消息">
              <InfoCircleOutlined style={{ marginLeft: 6, color: '#9C9A92', fontSize: 12 }} />
            </Tooltip>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            {Object.entries(EVENT_LABELS).map(([event, label]) => (
              <div key={event} className="atop-event-row">
                <span style={{ fontSize: 13, color: '#1A1A18' }}>{label}</span>
                <Switch
                  size="small"
                  checked={pref.eventSwitches[event] !== false}
                  onChange={v => setEventSwitch(event, v)}
                  checkedChildren="开" unCheckedChildren="关"
                />
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
