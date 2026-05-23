import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Form, Input, message } from 'antd'
import {
  DeploymentUnitOutlined,
  LineChartOutlined,
  LockOutlined,
  MailOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { authApi } from '@/api/auth'
import { usePermissionStore } from '@/store/permission'
import { useAuthStore } from '@/store/auth'
import type { LoginPayload } from '@/types'
import { inputLimit, maxLenRule } from '@/utils/fieldLimits'

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const setAuth = useAuthStore((s) => s.setAuth)
  const clearPerms = usePermissionStore((s) => s.clear)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [form] = Form.useForm<LoginPayload>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) {
      return
    }

    const returnUrl = searchParams.get('returnUrl') ?? '/dashboard'
    const decoded = decodeURIComponent(returnUrl)
    navigate(decoded.includes('/login') ? '/dashboard' : decoded, { replace: true })
  }, [isAuthenticated, navigate, searchParams])

  const handleSubmit = async (values: LoginPayload) => {
    setSubmitting(true)
    try {
      const res = await authApi.login(values)
      clearPerms()
      setAuth(res.user, res.accessToken, res.mustChangePwd)

      if (res.mustChangePwd) {
        navigate('/force-change-pwd', { replace: true })
        return
      }

      const returnUrl = searchParams.get('returnUrl') ?? '/dashboard'
      const decoded = decodeURIComponent(returnUrl)
      navigate(decoded.includes('/login') ? '/dashboard' : decoded, { replace: true })
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.response?.data?.data?.message || '登录失败，请检查邮箱和密码'
      message.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="atop-auth-shell">
      <main className="atop-login-frame">
        <section className="atop-login-visual" aria-label="平台能力展示">
          <div className="atop-auth-brand atop-auth-brand-compact">
            <div className="atop-auth-logo">A</div>
            <div>
              <div className="atop-auth-product">ATOP</div>
              <div className="atop-auth-product-sub">自动化编排调度平台</div>
            </div>
          </div>

          <div className="atop-login-brief" aria-hidden="true">
            <div>
              <LineChartOutlined />
              <span>运行观测</span>
            </div>
            <div>
              <ThunderboltOutlined />
              <span>任务触发</span>
            </div>
            <div>
              <DeploymentUnitOutlined />
              <span>流水线编排</span>
            </div>
          </div>
        </section>

        <section className="atop-login-card" aria-label="登录表单">
          <div className="atop-login-card-head">
            <div className="atop-login-card-icon">
              <ThunderboltOutlined />
            </div>
            <div>
              <div className="atop-login-title">登录平台</div>
              <div className="atop-login-subtitle">统一进入 ATOP 控制台、任务编排与运行中心</div>
            </div>
          </div>

          <Form
            form={form}
            onFinish={handleSubmit}
            layout="vertical"
            requiredMark={false}
            size="large"
            className="atop-auth-form"
          >
            <Form.Item
              name="email"
              label="邮箱"
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '请输入有效邮箱' },
                maxLenRule('email', '邮箱'),
              ]}
            >
              <Input
                prefix={<MailOutlined />}
                placeholder="admin@atop.local"
                autoComplete="email"
                {...inputLimit('email')}
              />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
                maxLenRule('password', '密码'),
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="请输入密码"
                autoComplete="current-password"
                {...inputLimit('password')}
              />
            </Form.Item>

            <div className="atop-login-tools">
              <span>登录后直接进入工作台</span>
              <Link to="/forgot-password">忘记密码？</Link>
            </div>

            <Form.Item className="atop-login-submit">
              <Button type="primary" htmlType="submit" block loading={submitting}>
                登录
              </Button>
            </Form.Item>
          </Form>

          <div className="atop-login-foot">© 2026 ATOP Platform</div>
        </section>
      </main>
    </div>
  )
}
