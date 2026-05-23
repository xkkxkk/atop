import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, Button, Form, Input, Progress, Result, Spin } from 'antd'
import { CheckCircleOutlined, LoginOutlined, LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/store/auth'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  if (!password) {
    return { score: 0, label: '', color: '#f0f0f0' }
  }

  let score = 0
  if (password.length >= 8) score += 1
  if (password.length >= 12) score += 1
  if (/[A-Z]/.test(password)) score += 1
  if (/[a-z]/.test(password)) score += 1
  if (/[0-9]/.test(password)) score += 1
  if (/[^A-Za-z0-9]/.test(password)) score += 1

  if (score <= 2) return { score: (score / 6) * 100, label: '弱', color: '#ff4d4f' }
  if (score <= 4) return { score: (score / 6) * 100, label: '中', color: '#faad14' }
  return { score: (score / 6) * 100, label: '强', color: '#52c41a' }
}

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [validating, setValidating] = useState(true)
  const [tokenInfo, setTokenInfo] = useState<{ valid: boolean; username?: string; email?: string; reason?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [form] = Form.useForm()

  const strength = getPasswordStrength(newPassword)

  useEffect(() => {
    if (!token) {
      setTokenInfo({ valid: false, reason: '缺少重置令牌，请重新申请' })
      setValidating(false)
      return
    }

    authApi
      .validateResetToken(token)
      .then((info) => setTokenInfo(info))
      .catch(() => setTokenInfo({ valid: false, reason: '链接无效，请重新申请' }))
      .finally(() => setValidating(false))
  }, [token])

  const handleSubmit = async (values: { newPassword: string }) => {
    setSubmitting(true)
    setError('')
    try {
      const auth = await authApi.resetPasswordByToken(token, values.newPassword)
      setAuth(auth.user, auth.accessToken, auth.mustChangePwd)
      setDone(true)
    } catch (err: any) {
      const msg = err?.response?.data?.message
      if (msg?.includes('过期')) {
        setError('重置链接已过期，请重新申请')
      } else {
        setError(msg || '重置失败，请稍后重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogoutAndLogin = async () => {
    await authApi.logout()
    useAuthStore.getState().clearAuth()
    navigate('/login', { replace: true })
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #EEF2FF 0%, #E0F2FE 50%, #ECFDF5 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: '40px 36px',
          width: 440,
          boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
          border: '0.5px solid rgba(0,0,0,0.08)',
        }}
      >
        {validating && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#9C9A92', fontSize: 13 }}>正在验证重置链接...</div>
          </div>
        )}

        {!validating && tokenInfo && !tokenInfo.valid && (
          <Result
            status="error"
            title="链接无效或已过期"
            subTitle={tokenInfo.reason}
            extra={[
              <Button key="retry" type="primary" onClick={() => navigate('/forgot-password')}>
                重新申请
              </Button>,
              <Link key="login" to="/login">
                <Button>返回登录</Button>
              </Link>,
            ]}
          />
        )}

        {done && (
          <div style={{ textAlign: 'center', padding: '10px 0 2px' }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: 20,
                background: 'linear-gradient(135deg, #ECFDF5, #E0F2FE)',
                border: '1px solid #BBF7D0',
                margin: '0 auto 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 14px 30px rgba(34,197,94,0.16)',
              }}
            >
              <CheckCircleOutlined style={{ color: '#16A34A', fontSize: 34 }} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1A1A18', marginBottom: 8 }}>密码已更新，已自动登录</div>
            <div style={{ fontSize: 13, color: '#647084', lineHeight: 1.7, marginBottom: 18 }}>
              新密码已经生效，当前浏览器已建立安全会话。你可以直接进入系统，也可以退出后稍后再登录。
            </div>
            <div
              style={{
                background: '#F8FAFC',
                border: '1px solid #E2E8F0',
                borderRadius: 12,
                padding: '12px 14px',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                textAlign: 'left',
                marginBottom: 20,
              }}
            >
              <SafetyCertificateOutlined style={{ color: '#2563EB', fontSize: 20 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A18' }}>账户保护已恢复</div>
                <div style={{ fontSize: 12, color: '#8C8C8C' }}>后续请使用新密码登录，旧重置链接已失效。</div>
              </div>
            </div>
            <Button
              type="primary"
              icon={<LoginOutlined />}
              block
              onClick={() => navigate('/dashboard', { replace: true })}
              style={{ height: 42, fontWeight: 600, marginBottom: 10 }}
            >
              进入系统
            </Button>
            <Button block onClick={handleLogoutAndLogin} style={{ height: 40 }}>
              退出并稍后登录
            </Button>
          </div>
        )}

        {!validating && tokenInfo?.valid && !done && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 12,
                  background: '#E6F1FB',
                  margin: '0 auto 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 22,
                }}
              >
                <LockOutlined style={{ color: '#2563EB' }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#1A1A18', marginBottom: 4 }}>重置密码</div>
              <div style={{ fontSize: 12, color: '#9C9A92' }}>
                账户：{tokenInfo.username}（{tokenInfo.email}）
              </div>
            </div>

            {error && (
              <Alert
                type="error"
                message={error}
                showIcon
                style={{ marginBottom: 16, fontSize: 13 }}
                closable
                onClose={() => setError('')}
              />
            )}

            <Form form={form} layout="vertical" onFinish={handleSubmit} size="large">
              <Form.Item
                name="newPassword"
                label="新密码"
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 8, message: '密码至少 8 位' },
                  maxLenRule('password', '新密码'),
                  {
                    validator: (_, value) => {
                      if (!value) return Promise.resolve()
                      if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) {
                        return Promise.reject(new Error('密码需包含大写字母、小写字母和数字'))
                      }
                      return Promise.resolve()
                    },
                  },
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
                  placeholder="至少 8 位，包含大小写字母和数字"
                  autoComplete="new-password"
                  onChange={(e) => setNewPassword(e.target.value)}
                  {...inputLimit('password')}
                />
              </Form.Item>

              {newPassword && (
                <div style={{ marginTop: -16, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#9C9A92' }}>密码强度</span>
                    <span style={{ color: strength.color, fontWeight: 500 }}>{strength.label}</span>
                  </div>
                  <Progress percent={strength.score} showInfo={false} strokeColor={strength.color} trailColor="#f0f0f0" size={['100%', 6] as any} />
                </div>
              )}

              <Form.Item
                name="confirmPassword"
                label="确认新密码"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请确认新密码' },
                  maxLenRule('password', '确认新密码'),
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('newPassword') === value) {
                        return Promise.resolve()
                      }
                      return Promise.reject(new Error('两次输入的密码不一致'))
                    },
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
                  placeholder="再次输入新密码"
                  autoComplete="new-password"
                  {...inputLimit('password')}
                />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" block loading={submitting} style={{ height: 42, fontWeight: 500 }}>
                  确认重置密码
                </Button>
              </Form.Item>
            </Form>
          </>
        )}
      </div>
    </div>
  )
}
