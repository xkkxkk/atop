export type VersionChannel = 'frontend' | 'backend'

export type VersionHistoryChannel = {
  channel: VersionChannel
  version: string
  buildTime: string
  commit: string
  env: string
  changes: string[]
}

export type VersionHistoryEntry = {
  version: string
  date: string
  time?: string
  title: string
  desc: string
  frontend?: VersionHistoryChannel
  backend?: VersionHistoryChannel
}

const commonEnv = 'production'

export const VERSION_HISTORY: VersionHistoryEntry[] = [
  {
    version: 'v1.0.26',
    date: '2026-05-22',
    time: '08:45',
    title: '移除文档中心能力',
    desc: '按平台定位收口，移除文档中心页面、左侧导航、全局搜索入口、文档渲染样式和相关前端渲染依赖；ATOP 保持聚焦 DevOps、流水线、版本和运行治理。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.26',
      buildTime: '2026-05-22 08:45',
      commit: 'remove-document-center-20260522',
      env: commonEnv,
      changes: [
        '移除 /documents 文档中心路由和页面源码，平台不再内置文档中心入口',
        '左侧导航和 Ctrl/Command + K 全局搜索去掉文档中心入口，避免用户进入已撤销功能',
        '删除文档中心样式、文档渲染类型声明和页面级懒加载引用，减少前端无效代码',
        '移除 react-markdown、pdfjs-dist、docx-preview、page-flip、pptxjs 等文档渲染依赖，恢复平台轻量依赖边界',
        '后续如需要完整文档能力，建议独立建设文档服务，再由 ATOP 按链接或接口关联',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.26',
      buildTime: '2026-05-22 08:45',
      commit: 'remove-document-center-20260522',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.26 信息，并从当前版本特性中移除文档中心定位',
      ],
    },
  },
  {
    version: 'v1.0.21',
    date: '2026-05-21',
    time: '23:25',
    title: '版本管理工作区外部间距修正',
    desc: '版本管理页容器改为纵向 flex 布局，并为工作区增加 10px 外部间距，确保概览卡片与工作区之间的间距稳定生效。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.21',
      buildTime: '2026-05-21 23:25',
      commit: 'version-workbench-spacing-fix-20260521',
      env: commonEnv,
      changes: [
        '版本管理页容器显式改为纵向 flex，使工作区高度和底部 10px 收口规则稳定生效',
        '版本管理工作区增加 10px margin-top，修复概览卡片与搜索区之间缺少外部间距的问题',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.21',
      buildTime: '2026-05-21 23:25',
      commit: 'version-workbench-spacing-fix-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.21 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.20',
    date: '2026-05-21',
    time: '23:05',
    title: '版本管理高度、搜索定位与复制修复',
    desc: '版本管理页工作区撑满到页面底部 10px，10 条版本完整展示；搜索和全局跳转支持 1.0.2 这类无 v 写法，并修复复制当前版本无反馈问题。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.20',
      buildTime: '2026-05-21 23:05',
      commit: 'version-page-height-search-copy-20260521',
      env: commonEnv,
      changes: [
        '版本管理工作区高度调高并撑满页面剩余空间，最终仍按页面底部 10px 收口',
        '左侧版本列表保持每页 10 条，列表区域随工作区高度展开，确保 10 条正常展示',
        '补齐顶部概览与工作区之间的视觉间距，避免搜索区贴住上方卡片',
        '版本搜索和 URL 参数支持 1.0.2、v1.0.2、V1.0.2 等写法，并自动切换到对应分页和版本',
        '复制当前版本增加剪贴板降级方案和成功/失败提示，避免按钮点击无反馈',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.20',
      buildTime: '2026-05-21 23:05',
      commit: 'version-page-height-search-copy-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.20 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.19',
    date: '2026-05-21',
    time: '22:40',
    title: '通知规则说明移除与版本管理页精修',
    desc: '移除通知规则页外部 Webhook 说明文案，版本管理页按 10 条分页展示，并强化当前使用版本标识、详情区信息层级和页面底部收口。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.19',
      buildTime: '2026-05-21 22:40',
      commit: 'notification-version-page-polish-20260521',
      env: commonEnv,
      changes: [
        '通知规则页移除外部 Webhook 规则统计说明，页面只保留规则概览和列表内容',
        '版本管理左侧列表调整为每页 10 条，并在列表区域内滚动，避免页面被历史版本撑高',
        '版本管理左侧列表直接标识当前使用版本，详情区继续同步显示当前使用标签',
        '版本详情的前端更新和后端更新卡片重排版本号、构建时间、提交标识和更新内容，提升可读性',
        '版本管理页顶部概览、工作区间距和底部留白收紧，页面底部按 10px 目标收口',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.19',
      buildTime: '2026-05-21 22:40',
      commit: 'notification-version-page-polish-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.19 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.18',
    date: '2026-05-21',
    time: '22:10',
    title: 'Jenkins 模板折叠与 Agent 容量收敛',
    desc: 'Jenkins 接入模板默认收起，运行大盘 Agent 容量状态只展示摘要节点，超出后跳转到 Jenkins Agent 资源视图查看全部。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.18',
      buildTime: '2026-05-21 22:10',
      commit: 'jenkins-template-agent-capacity-polish-20260521',
      env: commonEnv,
      changes: [
        'Jenkins 实例页的 Jenkins 接入模板默认收起，点击展开后再查看 Shared Library 和 Jenkinsfile 示例',
        '运行大盘 Agent 容量状态只展示当前卡片可承载的 3 个节点，避免节点过多撑高页面',
        'Agent 容量状态超出 3 个节点时显示查看更多入口，并跳转到 Jenkins 实例的 Agent 资源视图',
        'Jenkins 实例页支持 /settings/jenkins?view=agents 直接打开 Agent 节点资源视图',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.18',
      buildTime: '2026-05-21 22:10',
      commit: 'jenkins-template-agent-capacity-polish-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.18 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.17',
    date: '2026-05-21',
    time: '21:50',
    title: '版本管理菜单、分页与搜索优化',
    desc: '版本管理加入左侧菜单，页面底部收紧到 10px，左侧版本列表支持分页，并支持全局搜索定位到指定历史版本。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.17',
      buildTime: '2026-05-21 21:50',
      commit: 'version-menu-search-pagination-polish-20260521',
      env: commonEnv,
      changes: [
        '左侧导航新增版本管理入口，进入 /versions 时菜单和顶部标签可正常高亮',
        '版本管理页显示当前使用版本，当前版本在详情区增加标识',
        '版本列表改为分页展示，避免左侧长列表撑高页面和产生多余底部空白',
        '页面工作区按内容高度展示，底部只保留 10px 间距',
        '全局命令搜索支持检索版本历史，搜索 v1.0.13 等版本号后可直接跳转并选中对应版本',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.17',
      buildTime: '2026-05-21 21:50',
      commit: 'version-menu-search-pagination-polish-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.17 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.16',
    date: '2026-05-21',
    time: '21:20',
    title: '版本管理页收尾与打包修复',
    desc: '新增独立版本管理页，支持搜索、前后端筛选和复制版本说明，并修复构建兼容性后重新打包。',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.16',
      buildTime: '2026-05-21 21:20',
      commit: 'version-management-page-finalize-20260521',
      env: commonEnv,
      changes: [
        '新增 /versions 独立版本管理页，完整展示历史版本、前端记录、后端记录和当前版本详情',
        '版本中心抽屉和悬浮入口新增跳转完整版本历史，弹窗只保留更新提醒与摘要',
        '版本管理页支持关键字搜索、前后端筛选和一键复制当前版本说明',
        '修复版本管理页 Array.at 兼容性问题，保证现有 TypeScript 配置可通过构建',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.16',
      buildTime: '2026-05-21 21:20',
      commit: 'version-management-page-finalize-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.16 信息，前后端版本提示可按同一版本号确认部署状态',
      ],
    },
  },
  {
    version: 'v1.0.15',
    date: '2026-05-21',
    time: '20:25',
    title: '版本弹窗与大盘数据合并',
    desc: '版本提示等待前后端检测完成后一次性展示，并把原全屏大盘的高频流水线质量、质量风险和 Agent 容量状态并入运行大盘',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.15',
      buildTime: '2026-05-21 20:25',
      commit: 'version-modal-dashboard-data-merge-20260521',
      env: commonEnv,
      changes: [
        '版本弹窗等待前端静态版本和后端版本接口都完成检测后再一次性汇总展示',
        '版本弹窗改为单一滚动区和版本摘要布局，避免前后端内容分段闪现和卡片内部滚动条',
        '原全屏大盘中的高频流水线质量、质量风险 Top 5、Agent 容量状态已并入运行大盘',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.15',
      buildTime: '2026-05-21 20:25',
      commit: 'version-modal-dashboard-data-merge-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.15 更新说明，前后端版本管理可按同一版本号展示',
        '版本接口补充本次大盘和版本中心改造说明，方便线上确认部署内容',
      ],
    },
  },
  {
    version: 'v1.0.14',
    date: '2026-05-21',
    time: '20:10',
    title: '筛选视图与大盘全屏优化',
    desc: '筛选条件命中预设或已保存视图时不再重复保存，运行大盘全屏改为当前页面直接进入全屏，并统一页面底部间距',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.14',
      buildTime: '2026-05-21 20:10',
      commit: 'dashboard-fullscreen-filter-view-save-state-20260521',
      env: commonEnv,
      changes: [
        '筛选条件已命中预设或已保存视图时，保存当前进入已保存状态，避免重复保存',
        '运行大盘的全屏按钮改为当前页面直接进入浏览器全屏，不再跳转独立全屏页',
        '统一页面底部 10px 间距，Jenkins 实例等页面底部不再贴边',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.14',
      buildTime: '2026-05-21 20:10',
      commit: 'dashboard-fullscreen-filter-view-save-state-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口同步返回 v1.0.14 信息，方便版本弹窗展示前后端一致状态',
      ],
    },
  },
  {
    version: 'v1.0.13',
    date: '2026-05-21',
    time: '19:05',
    title: '搜索、消息与筛选视图体验优化',
    desc: '命令搜索重新打开自动清空，消息铃铛简化底部动作，筛选视图改为用户级面板并补齐当前选中态',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.13',
      buildTime: '2026-05-21 19:05',
      commit: 'command-bell-filter-views-polish-20260521',
      env: commonEnv,
      changes: [
        '全局命令搜索每次打开自动清空输入',
        '消息铃铛去掉冗余关闭按钮，只保留查看全部消息入口',
        '保存筛选视图改为用户级视图面板，常用预设和我的视图分区并展示当前选中态',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.13',
      buildTime: '2026-05-21 19:05',
      commit: 'command-bell-filter-views-polish-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口补充本次前端体验优化说明',
      ],
    },
  },
  {
    version: 'v1.0.12',
    date: '2026-05-21',
    title: '通知测试渠道统计修正',
    desc: '通知规则测试结果只统计实际勾选并发送成功的渠道，未勾选邮件时不再展示邮箱数量',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.12',
      buildTime: '2026-05-21',
      commit: 'notification-test-channel-count-20260521',
      env: commonEnv,
      changes: [
        '通知规则测试结果只统计实际勾选且发送成功的渠道，避免未勾选邮件时展示邮箱数量',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.12',
      buildTime: '2026-05-21',
      commit: 'notification-test-channel-count-20260521',
      env: commonEnv,
      changes: [
        '通知规则测试发送按实际启用渠道返回统计，不再返回未勾选渠道数量',
      ],
    },
  },
  {
    version: 'v1.0.11',
    date: '2026-05-21',
    title: '固定标签请求风暴加固',
    desc: '固定标签偏好读取增加同用户同权限签名硬闸门，避免重复渲染或旧 effect 依赖触发连续请求',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.11',
      buildTime: '2026-05-21',
      commit: 'worktabs-preference-request-guard-20260521',
      env: commonEnv,
      changes: [
        '固定标签偏好读取增加同用户同权限签名硬闸门，防止重复渲染触发请求风暴',
        '接口不可用提示增加去重降噪，减少反复弹出错误提醒',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.11',
      buildTime: '2026-05-21',
      commit: 'worktabs-preference-request-guard-20260521',
      env: commonEnv,
      changes: [
        '用户偏好接口继续作为顶部固定标签持久化入口，版本接口同步记录修复说明',
      ],
    },
  },
  {
    version: 'v1.0.10',
    date: '2026-05-21',
    title: '通知规则测试与请求风暴修正',
    desc: '通知规则测试按接收人配置真实发送，修复固定标签偏好接口循环请求，并优化接口错误提示和版本弹窗交互',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.10',
      buildTime: '2026-05-21',
      commit: 'notification-test-worktabs-fix-20260521',
      env: commonEnv,
      changes: [
        '修复顶部固定标签偏好接口循环请求，接口不可用提示增加去重降噪',
        '版本弹窗提醒按钮点击后立即关闭弹窗',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.10',
      buildTime: '2026-05-21',
      commit: 'notification-test-worktabs-fix-20260521',
      env: commonEnv,
      changes: [
        '通知规则测试发送改为按规则接收人配置投递，支持全体成员、项目负责人和自定义邮箱',
      ],
    },
  },
  {
    version: 'v1.0.9',
    date: '2026-05-21',
    title: '版本提示展示修正',
    desc: '版本弹窗清晰展示前端和后端更新内容，提醒按钮点击即关闭，并优化弹窗内容布局',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.9',
      buildTime: '2026-05-21',
      commit: 'version-dialog-display-fix-20260521',
      env: commonEnv,
      changes: [
        '版本弹窗按前端和后端分区展示更新内容',
        '提醒按钮点击后立即关闭弹窗',
        '版本弹窗样式收紧，避免更新内容卡片拥挤和状态标签错位',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.9',
      buildTime: '2026-05-21',
      commit: 'version-dialog-display-fix-20260521',
      env: commonEnv,
      changes: [
        '后端版本接口补充本次后端更新内容，版本弹窗可正确展示后端变更',
      ],
    },
  },
  {
    version: 'v1.0.8',
    date: '2026-05-21',
    title: '用户级筛选视图与固定标签',
    desc: '筛选视图改为后端按用户保存，通知规则测试后端真实发送，运行大盘默认固定且顶部标签支持右键菜单和用户偏好持久化',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.8',
      buildTime: '2026-05-21',
      commit: 'user-filter-views-worktabs-20260521',
      env: commonEnv,
      changes: [
        '运行大盘作为默认固定标签常驻',
        '顶部标签支持右键菜单，固定标签按用户偏好保存',
        '筛选视图改为用户级保存，刷新和换设备后仍保留',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.8',
      buildTime: '2026-05-21',
      commit: 'user-filter-views-worktabs-20260521',
      env: commonEnv,
      changes: [
        '新增 saved_filter_views 表与 /saved-filter-views 接口，筛选视图按用户和页面保存',
        '新增 user_preferences 表与 /users/me/preferences/:key 接口，顶部固定标签按用户偏好保存',
        '新增 /notifications/rules/:id/test 接口，支持站内消息、邮件、钉钉、飞书和自定义 Webhook 真实测试发送',
      ],
    },
  },
  {
    version: 'v1.0.7',
    date: '2026-05-21',
    title: '筛选视图与权限变更确认',
    desc: '运行记录、流水线、审计日志新增保存筛选视图，角色权限保存前展示变更 diff，通知规则支持测试发送',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.7',
      buildTime: '2026-05-21',
      commit: 'filter-views-role-diff-20260521',
      env: commonEnv,
      changes: [
        '运行记录、流水线、审计日志新增个人筛选视图保存与常用预设',
        '角色权限保存前新增本次变更 diff 确认，避免误改权限',
        '通知规则新增测试发送入口，并复用通知规则编辑权限控制',
      ],
    },
  },
  {
    version: 'v1.0.6',
    date: '2026-05-21',
    title: '命令搜索与异常处理工作流',
    desc: '新增全局命令搜索、流水线运行前检查、失败归因摘要、大盘异常处理流、顶部标签管理和用户/角色右键快捷菜单',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.6',
      buildTime: '2026-05-21',
      commit: 'command-search-exception-workflow-20260521',
      env: commonEnv,
      changes: [
        '新增 Ctrl/⌘ + K 全局命令搜索，可搜索页面、流水线、运行记录、用户和通知规则',
        '流水线触发前增加本地预检，阻断必填参数缺失、Jenkins 异常、Job 漏配和画布起始节点问题',
        '运行详情新增失败归因摘要，聚合失败组件、Jenkins 回执和处理建议',
        '运行大盘需要关注事项支持认领、处理完成、忽略、备注和跳转处理',
        '顶部标签新增固定、关闭其他、关闭左侧、关闭右侧和关闭全部未固定',
        '用户管理和角色管理列表新增右键快捷菜单',
      ],
    },
  },
  {
    version: 'v1.0.5',
    date: '2026-05-10',
    title: '默认管理员保护',
    desc: '用户管理隐藏默认管理员的编辑基本信息和停用入口，并在接口层限制编辑和启停操作',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.5',
      buildTime: '2026-05-10',
      commit: 'default-admin-protection-20260510',
      env: commonEnv,
      changes: [
        '用户管理隐藏默认管理员的编辑基本信息和停用入口',
      ],
    },
    backend: {
      channel: 'backend',
      version: 'v1.0.5',
      buildTime: '2026-05-10',
      commit: 'default-admin-protection-20260510',
      env: commonEnv,
      changes: [
        '接口层限制默认管理员编辑和启停操作',
      ],
    },
  },
  {
    version: 'v1.0.4',
    date: '2026-05-10',
    title: '大盘与用户管理修正',
    desc: 'Agent 口径、长时间运行关注项、趋势筛选名称和用户导入模板统一优化',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.4',
      buildTime: '2026-05-10',
      commit: 'dashboard-user-management-fix-20260510',
      env: commonEnv,
      changes: [
        'Agent 口径、长时间运行关注项、趋势筛选名称和用户导入模板统一优化',
      ],
    },
  },
  {
    version: 'v1.0.3',
    date: '2026-05-10',
    title: '版本提示只保留最新',
    desc: '浏览器未关闭时，多次发版只显示服务器当前最新版本的更新内容',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.3',
      buildTime: '2026-05-10',
      commit: 'latest-version-notice-only-20260510',
      env: commonEnv,
      changes: [
        '浏览器未关闭时，多次发版只显示服务器当前最新版本的更新内容',
      ],
    },
  },
  {
    version: 'v1.0.2',
    date: '2026-05-10',
    title: '版本更新内容提示',
    desc: '新版本弹窗按前端和后端分别展示更新内容，只显示实际更新的一端',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.2',
      buildTime: '2026-05-10',
      commit: 'version-update-content-20260510',
      env: commonEnv,
      changes: [
        '新版本弹窗按前端和后端分别展示更新内容',
        '只显示实际更新的一端',
      ],
    },
  },
  {
    version: 'v1.0.1',
    date: '2026-05-10',
    title: '版本更新提示修正',
    desc: '浏览器未刷新时定时检测服务器 version.json 与后端版本接口，发现新版本后提示刷新',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.1',
      buildTime: '2026-05-10',
      commit: 'version-update-notice-fix-20260510',
      env: commonEnv,
      changes: [
        '浏览器未刷新时定时检测服务器 version.json 与后端版本接口',
        '发现新版本后提示刷新',
      ],
    },
  },
  {
    version: 'v1.0.0',
    date: '2026-05-10',
    title: '前端 UI 一致性优化',
    desc: '导航页签、登录页、运行记录筛选区与管理页样式统一',
    frontend: {
      channel: 'frontend',
      version: 'v1.0.0',
      buildTime: '2026-05-10',
      commit: 'frontend-ui-consistency-20260510',
      env: commonEnv,
      changes: [
        '导航页签、登录页、运行记录筛选区与管理页样式统一',
      ],
    },
  },
]

export const latestVersionHistory = VERSION_HISTORY[0]
