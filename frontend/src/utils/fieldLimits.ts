export const FIELD_LIMITS = {
  name: 120,
  displayName: 100,
  description: 500,
  remark: 500,
  username: 100,
  email: 200,
  password: 128,
  roleKey: 50,
  project: 100,
  dimensionValue: 100,
  dimensionDisplayName: 200,
  jenkinsName: 200,
  url: 1000,
  jenkinsUsername: 100,
  token: 1000,
  variableKey: 200,
  variableValue: 5000,
  pipelineName: 120,
  jobName: 200,
  cronExpr: 100,
  paramName: 80,
  paramValue: 1000,
  paramDescription: 300,
  templateTitle: 300,
  templateBody: 4000,
  emails: 2000,
  script: 50000,
  command: 5000,
  path: 500,
  agentLabel: 100,
  stageName: 200,
  artifactPath: 500,
  dockerImage: 500,
  dockerMount: 1000,
  runBash: 200,
  bodyTemplate: 4000,
} as const

export type FieldLimitKey = keyof typeof FIELD_LIMITS

export function limitMessage(label: string, max: number) {
  return `${label}最多 ${max} 个字符，请缩短后再保存`
}

export function maxLenRule(key: FieldLimitKey, label: string) {
  const max = FIELD_LIMITS[key]
  return { max, message: limitMessage(label, max) }
}

export function limitHint(key: FieldLimitKey) {
  return `最多 ${FIELD_LIMITS[key]} 个字符`
}

export function inputLimit(key: FieldLimitKey) {
  return { maxLength: FIELD_LIMITS[key], showCount: true }
}
