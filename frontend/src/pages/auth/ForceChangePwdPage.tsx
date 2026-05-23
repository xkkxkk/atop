import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Form, Input, Progress } from 'antd'
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
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

export default function ForceChangePwdPage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const setAuth = useAuthStore((s) => s.setAuth)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const strength = getPasswordStrength(newPassword)

  const handleSubmit = async (values: { oldPassword: string; newPassword: string }) => {
    setLoading(true)
    setError('')
    try {
      const auth = await authApi.changePassword(values)
      setAuth(auth.user, auth.accessToken, auth.mustChangePwd)
      navigate('/dashboard', { replace: true })
    } catch (err: any) {
      const msg = err?.response?.data?.message
      if (msg?.includes('旧密码')) {
        setError('旧密码不正确，请重新输入')
      } else {
        setError(msg || '修改失败，请稍后重试')
      }
    } finally {
      setLoading(false)
    }
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
          border: '0.5px solid rgba(0,0,0,0.10)',
          borderRadius: 16,
          padding: '40px 36px',
          width: 440,
          boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, #FFF7E6, #FFFBE6)',
              border: '1px solid #ffd666',
              margin: '0 auto 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
            }}
          >
            <SafetyCertificateOutlined style={{ color: '#d48806' }} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#1A1A18', marginBottom: 6 }}>首次登录，请修改密码</div>
          <div style={{ fontSize: 13, color: '#9C9A92', lineHeight: 1.6 }}>
            当前账户仍在使用初始密码，请先完成密码更新后再进入系统。
          </div>
        </div>

        <div
          style={{
            background: '#F8F9FA',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: '#E6F1FB',
              color: '#185FA5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {user?.username?.slice(0, 1).toUpperCase() ?? '?'}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#1A1A18' }}>{user?.username}</div>
            <div style={{ fontSize: 11, color: '#9C9A92' }}>{user?.email}</div>
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
            name="oldPassword"
            label="当前密码（初始密码）"
            rules={[
              { required: true, message: '请输入当前密码' },
              maxLenRule('password', '当前密码'),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#9C9A92' }} />}
              placeholder="请输入当前密码"
              autoComplete="current-password"
              onChange={() => setError('')}
              {...inputLimit('password')}
            />
          </Form.Item>

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
                  const hasUpper = /[A-Z]/.test(value)
                  const hasLower = /[a-z]/.test(value)
                  const hasNumber = /[0-9]/.test(value)
                  if (!hasUpper || !hasLower || !hasNumber) {
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
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                <span style={{ color: '#9C9A92' }}>密码强度</span>
                <span style={{ color: strength.color, fontWeight: 500 }}>{strength.label}</span>
              </div>
              <Progress percent={strength.score} showInfo={false} strokeColor={strength.color} trailColor="#f0f0f0" size={[ '100%', 6 ] as any} />
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
            <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 42, fontWeight: 500, fontSize: 15 }}>
              修改密码并进入系统
            </Button>
          </Form.Item>
        </Form>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 11, color: '#9C9A92' }}>
          修改成功后，当前登录状态会继续保持。
        </div>
      </div>
    </div>
  )
}
