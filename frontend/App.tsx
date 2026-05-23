import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { theme } from './styles/theme'
import MainLayout from './components/layout/MainLayout'
import AuthGuard from './components/layout/AuthGuard'

dayjs.locale('zh-cn')

const LoginPage = lazy(() => import('./pages/auth/LoginPage'))
const ForceChangePwdPage = lazy(() => import('./pages/auth/ForceChangePwdPage'))
const CleanupPage = lazy(() => import('./pages/admin/CleanupPage'))
const RolePage = lazy(() => import('./pages/admin/RolePage'))
const NotificationRulePage = lazy(() => import('./pages/settings/NotificationRulePage'))
const NotificationCenterPage = lazy(() => import('./pages/notifications/NotificationCenterPage'))
const PipelineVersionPage = lazy(() => import('./pages/pipelines/PipelineVersionPage'))
const TrendPage = lazy(() => import('./pages/dashboard/TrendPage'))

const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'))
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'))
const RunDetailPage = lazy(() => import('./pages/dashboard/RunDetailPage'))
const RunHistoryPage = lazy(() => import('./pages/dashboard/RunHistoryPage'))
const ReportedRunDetailPage = lazy(() => import('./pages/dashboard/ReportedRunDetailPage'))
const PipelineListPage = lazy(() => import('./pages/pipelines/PipelineListPage'))
const PipelineEditPage = lazy(() => import('./pages/pipelines/PipelineEditPage'))
const TriggerRunPage = lazy(() => import('./pages/pipelines/TriggerRunPage'))
const JenkinsPage = lazy(() => import('./pages/settings/JenkinsPage'))
const VarsPage = lazy(() => import('./pages/settings/VarsPage'))
const DimensionsPage = lazy(() => import('./pages/settings/DimensionsPage'))
const UsersPage = lazy(() => import('./pages/admin/UsersPage'))
const AuditPage = lazy(() => import('./pages/admin/AuditPage'))
const ProfilePage = lazy(() => import('./pages/profile/ProfilePage'))
const VersionManagementPage = lazy(() => import('./pages/versions/VersionManagementPage'))

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={theme}
      form={{
        validateMessages: {
          required: "'${label}' 为必填项",
          types: {
            email: "'${label}' 不是有效的邮箱格式",
            url: "'${label}' 不是有效的 URL",
            number: "'${label}' 必须是数字",
          },
          string: {
            min: "'${label}' 最少 ${min} 个字符",
            max: "'${label}' 最多 ${max} 个字符",
          },
          pattern: {
            mismatch: "'${label}' 格式不正确",
          },
        },
      }}
    >
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/force-change-pwd" element={<ForceChangePwdPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route element={<AuthGuard />}>
              <Route element={<MainLayout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="runs/:id" element={<RunDetailPage />} />
                <Route path="run-history" element={<RunHistoryPage />} />
                <Route path="reported-runs/:id" element={<ReportedRunDetailPage />} />
                <Route path="pipelines" element={<PipelineListPage />} />
                <Route path="pipelines/new" element={<PipelineEditPage />} />
                <Route path="pipelines/:id/edit" element={<PipelineEditPage />} />
                <Route path="pipelines/:id/run" element={<TriggerRunPage />} />
                <Route path="settings/jenkins" element={<JenkinsPage />} />
                <Route path="settings/vars" element={<VarsPage />} />
                <Route path="settings/dimensions" element={<DimensionsPage />} />
                <Route path="admin/users" element={<UsersPage />} />
                <Route path="admin/audit" element={<AuditPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="versions" element={<VersionManagementPage />} />
                <Route path="dashboard/fullscreen" element={<Navigate to="/dashboard" replace />} />
                <Route path="settings/notification-rules" element={<NotificationRulePage />} />
                <Route path="notifications" element={<NotificationCenterPage />} />
                <Route path="pipelines/:id/versions" element={<PipelineVersionPage />} />
                <Route path="trends" element={<TrendPage />} />
                <Route path="admin/roles" element={<RolePage />} />
                <Route path="admin/cleanup" element={<CleanupPage />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ConfigProvider>
  )
}
