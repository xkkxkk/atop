import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Form, Input, Result } from 'antd'
import { ArrowLeftOutlined, MailOutlined } from '@ant-design/icons'
import { authApi } from '@/api/auth'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

export default function ForgotPasswordPage() {
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (values: { email: string }) => {
    setSubmitting(true)
    setError('')
    try {
      await authApi.forgotPassword(values.email)
      setEmail(values.email)
      setSent(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || '发送失败，请稍后重试')
    } finally {
      setSubmitting(false)
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
          borderRadius: 16,
          padding: '40px 36px',
          width: 420,
          boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
          border: '0.5px solid rgba(0,0,0,0.08)',
        }}
      >
        {sent ? (
          <Result
            icon={<MailOutlined style={{ fontSize: 48, color: '#2563EB' }} />}
            title="重置邮件已发送"
            subTitle={
              <div style={{ fontSize: 13, color: '#5F5E5A', lineHeight: 1.8 }}>
                如果 <strong>{email}</strong> 已在平台注册，系统会发送重置链接。
                <br />
                请检查收件箱和垃圾邮件目录，链接 30 分钟内有效。
              </div>
            }
            extra={
              <Link to="/login">
                <Button type="primary" icon={<ArrowLeftOutlined />}>
                  返回登录
                </Button>
              </Link>
            }
          />
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
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
                <MailOutlined style={{ color: '#2563EB' }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#1A1A18', marginBottom: 6 }}>忘记密码</div>
              <div style={{ fontSize: 13, color: '#9C9A92', lineHeight: 1.6 }}>
                输入注册邮箱，我们会发送密码重置链接
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

            <Form layout="vertical" onFinish={handleSubmit} size="large">
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: '请输入邮箱' },
                  { type: 'email', message: '请输入有效邮箱' },
                  maxLenRule('email', '邮箱'),
                ]}
              >
                <Input
                  prefix={<MailOutlined style={{ color: '#9C9A92' }} />}
                  placeholder="请输入注册邮箱"
                  autoComplete="email"
                  {...inputLimit('email')}
                />
              </Form.Item>

              <Form.Item style={{ marginBottom: 12 }}>
                <Button type="primary" htmlType="submit" block loading={submitting} style={{ height: 42, fontWeight: 500 }}>
                  发送重置链接
                </Button>
              </Form.Item>
            </Form>

            <div style={{ textAlign: 'center', fontSize: 13, color: '#9C9A92' }}>
              <Link to="/login" style={{ color: '#2563EB' }}>
                <ArrowLeftOutlined style={{ marginRight: 4 }} />
                返回登录
              </Link>
            </div>

            <div
              style={{
                marginTop: 20,
                padding: '12px 16px',
                background: '#F8F9FA',
                borderRadius: 10,
                fontSize: 12,
                color: '#9C9A92',
                lineHeight: 1.7,
              }}
            >
              <strong style={{ color: '#5F5E5A' }}>如果没有邮箱访问权限：</strong>
              <br />
              请联系系统管理员直接重置密码。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
