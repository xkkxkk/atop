export interface User {
  id: string
  username: string
  email: string
  role: string
  roles: string[]
  projects: string[]
  status: 'active' | 'disabled'
  avatarUrl?: string
  createdAt: string
}

export interface LoginPayload {
  email: string
  password: string
}

export interface LoginResponse {
  accessToken: string
  mustChangePwd: boolean
  user: User & { mustChangePwd?: boolean }
}

export type DimensionType = 'project' | 'environment' | 'product' | 'os' | 'run_type'

export interface DimensionItem {
  id: string
  dimension: DimensionType
  value: string
  displayName: string
  sortOrder: number
}

export interface JenkinsInstance {
  id: string
  name: string
  url: string
  username: string
  status: 'ok' | 'unreachable' | 'unknown'
  isDefault: boolean
  projectBindings: string[]
  agentSyncMode?: 'all' | 'fixed'
  fixedNodes?: string[]
  lastPingAt?: string
  createdBy?: string
  createdAt?: string
  updatedBy?: string
  updatedAt?: string
}

export interface AgentLabel {
  id: string
  label: string
  jenkinsInstanceId: string
  jenkinsInstanceName: string
  onlineCount: number
  totalCount: number
  lastSyncAt?: string
}

export interface AgentNode {
  id: string
  nodeId: string
  name: string
  labelId: string
  jenkinsInstanceId: string
  online: boolean
  os?: string
  labels?: string[]
  lastSyncAt: string
}

export interface GlobalVar {
  id: string
  key: string
  value: string
  scope: 'system' | 'project'
  projectId?: string
  createdBy?: string
  createdAt: string
  updatedBy?: string
  updatedAt: string
}

export type TestSetStatus = 'enabled' | 'disabled'

export interface TestSet {
  id: string
  name: string
  project: string
  environment: string
  product: string
  os: string
  runType: string
  branch?: string
  status: TestSetStatus
  agentLabel: string
  tags: string[]
  unit?: string
  priority: number
  timeout?: number
  stageNum: number
  cpulock: boolean
  cpulockScript?: string
  dependsOn?: string[]
  skipOnDepFailure?: boolean
  remark?: string
  configJson: TestSetConfig
  artifactOutput?: string
  artifactInput?: string
  operatorName?: string
  operatorId?: string
  leaderName?: string
  leaderId?: string
  createdBy?: string
  createdAt: string
  updatedBy?: string
  updatedAt: string
  lastRunStatus?: TaskRunStatus
  lastRunAt?: string
}

export interface TestSetConfig {
  setup: SetupConfig
  execCmds: ExecCmd[]
  teardown: TeardownConfig
  reports?: ReportConfig[]
}

export interface SetupConfig {
  downloads: DownloadItem[]
  preScript?: string
}

export interface DownloadItem {
  source: string
  repoType: 'artifact' | 'curl_file' | 'git' | 'url'
  stage?: string
  sourceInfolder?: string
  destPath: string
  cmd?: string
}

export type DockerMode = 'internal' | 'native' | 'none'

export interface ExecCmd {
  cmdLabel: string
  dockerMode: DockerMode
  dockerImgReadfile?: string
  dockerImgLabel?: string
  dockerImage?: string
  dockerMount?: string
  cmdRundir?: string
  runBash?: string
  envVars: Array<{ key: string; value: string }>
  cmd: string
  failPolicy: 'block' | 'continue' | 'abort'
}

export interface TeardownConfig {
  cleanWorkspace: boolean
  keepArtifacts: string[]
  stopDocker: boolean
  postScript?: string
}

export interface ReportConfig {
  trigger: 'before' | 'after' | 'both'
  url: string
  method: 'POST' | 'GET'
  headers?: Array<{ key: string; value: string }>
  bodyTemplate: string
}

export type TriggerType = 'manual' | 'cron' | 'webhook' | 'child'

export interface PipelineParam {
  name: string
  type: 'string' | 'number' | 'boolean' | 'choice'
  defaultValue: string
  description?: string
  choices?: string[]
  required: boolean
}

export interface JenkinsJobBinding {
  jenkinsInstanceId: string
  jobName: string
  matchProject?: string
  matchOs?: string
}

export interface Pipeline {
  id: string
  name: string
  project: string
  environment: string
  product: string
  os?: string
  runType?: string
  triggerType: TriggerType
  cronExpr?: string
  jenkinsBindings: JenkinsJobBinding[]
  params: PipelineParam[]
  stageConfigJson: object
  dagConfigJson?: string | PipelineDAGConfig
  createdBy: string
  createdByName?: string
  createdAt: string
  updatedBy?: string
  updatedByName?: string
  updatedAt?: string
  lastRunStatus?: PipelineRunStatus
  lastRunAt?: string
  testSetCount: number
  currentRole?: 'owner' | 'operator' | 'viewer' | 'legacy' | ''
  canEdit?: boolean
  canTrigger?: boolean
}

export type PipelineRunStatus =
  | 'pending'
  | 'submitting'
  | 'queued_in_jenkins'
  | 'waiting'
  | 'running'
  | 'success'
  | 'failed'
  | 'aborted'
  | 'error'
  | 'blocked'

export interface PipelineRun {
  id: string
  pipelineId: string
  pipelineName: string
  status: PipelineRunStatus
  triggeredBy: string
  triggerType: TriggerType
  runtimeParams: Record<string, string>
  remark?: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  totalCount: number
  successCount: number
  failedCount: number
  runningCount: number
  blockedCount: number
  queuedCount: number
  passRate: number
  abortReason?: string
  errorSummary?: string
  triggeredByName?: string
  jenkinsBuildId?: number
  jenkinsQueueId?: number
  jenkinsBuildUrl?: string
  projectGroups: ProjectGroup[]
}

export interface ProjectGroup {
  project: string
  status: PipelineRunStatus
  totalCount: number
  doneCount: number
  passRate: number
  durationMs?: number
}

export type TaskRunStatus =
  | 'pending'
  | 'submitting'
  | 'submit_failed'
  | 'queued_in_jenkins'
  | 'waiting'
  | 'running'
  | 'success'
  | 'failed'
  | 'error'
  | 'aborted'
  | 'blocked'

export type LogStatus = 'unknown' | 'available' | 'expired'

export interface TaskRun {
  id: string
  pipelineRunId: string
  testSetId: string
  testSetName: string
  project: string
  agentLabel: string
  dagLayer?: number
  dagNodeId?: string
  dagNodeType?: PipelineDAGNodeType | string
  dagDetached?: boolean
  dagJoinPolicy?: 'all' | 'any'
  dagFailurePolicy?: 'block' | 'continue'
  subPipelineId?: string
  subRunId?: string
  status: TaskRunStatus
  phase?: string
  nodeName?: string
  jenkinsBuildId?: number
  jenkinsQueueId?: number
  jenkinsBuildUrl?: string
  logStatus: LogStatus
  logCheckedAt?: string
  errorSummary?: string
  stageSummaryJson?: StageInfo[]
  outputs?: Record<string, unknown>
  durationMs?: number
  passRate?: number
  blockedByTaskId?: string
  startedAt?: string
  finishedAt?: string
}

export type DAGEdgeType = 'wait' | 'detached'

export interface PipelineDAGEdge {
  id?: string
  source: string
  target: string
  type?: DAGEdgeType
}

export type PipelineDAGNodeType = 'testset' | 'pipeline' | 'jenkins' | 'gate'

export interface PipelineDAGNode {
  id: string
  type: PipelineDAGNodeType
  refId?: string
  label: string
  dependsOn: string[]
  joinPolicy?: 'all' | 'any'
  failurePolicy?: 'block' | 'continue'
  x: number
  y: number
  paramMapping?: Record<string, string>
  inputMapping?: Record<string, string>
  requiredOutputs?: string[]
  config?: Record<string, unknown>
}

export type PipelineDesignerComponentType = 'jenkins' | 'pipeline' | 'gate'

export interface PipelineDesignerComponent {
  id: string
  type: PipelineDesignerComponentType
  label: string
  x: number
  y: number
  refId?: string
  config?: Record<string, unknown>
  joinPolicy?: 'all' | 'any'
  failurePolicy?: 'block' | 'continue'
  paramMapping?: Record<string, string>
  inputMapping?: Record<string, string>
  requiredOutputs?: string[]
}

export interface PipelineDAGConfig {
  nodes: PipelineDAGNode[]
  edges?: PipelineDAGEdge[]
  designer?: {
    components: PipelineDesignerComponent[]
    edges?: PipelineDAGEdge[]
  }
}

export interface StageInfo {
  id: string
  name: 'Set Up' | 'Exec Cmd' | 'Report Status' | 'Tear Down'
  status: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS' | 'NOT_EXECUTED'
  durationMs: number
  logHref?: string
}

export interface UserRecord {
  id: string
  username: string
  email: string
  role: User['role']
  roles: string[]
  projects: string[]
  status: 'active' | 'disabled'
  avatarUrl?: string
  createdAt: string
  lastLoginAt?: string
}

export interface AuditLog {
  id: string
  userId: string
  username: string
  operatorName?: string
  operatorEmail?: string
  action: string
  resourceType: string
  resourceId: string
  resourceName: string
  diffJson?: object | string
  ip: string
  button?: string
  module?: string
  createdAt: string
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ApiError {
  code: string
  message: string
  detail?: string
}
