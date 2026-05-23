import client from './client'
import type { JenkinsInstance, AgentLabel, AgentNode, GlobalVar, DimensionItem, DimensionType } from '@/types'

// Unified response unwrapper
// Backend: { code, message, data } — single item
// Backend: { code, message, data: { items, total, page, pageSize } } — page
const unwrap = <T>(r: { data: { data: T } }): T => r.data.data
const unwrapList = <T>(r: { data: { data: T[] } }): T[] => r.data.data ?? []

// ── Dimension dict ────────────────────────────────────────────────────────
export const dimensionApi = {
  list: (dimension?: DimensionType) =>
    client.get('/dimension-dict', { params: { dimension } })
      .then((r) => (r.data.data ?? []) as DimensionItem[]),

  create: (data: Partial<DimensionItem>) =>
    client.post('/dimension-dict', data).then(unwrap<DimensionItem>),

  update: (id: string, data: Partial<DimensionItem>) =>
    client.put(`/dimension-dict/${id}`, data).then(unwrap<DimensionItem>),

  delete: (id: string) =>
    client.delete(`/dimension-dict/${id}`).then((r) => r.data),
}

// ── Jenkins instances ─────────────────────────────────────────────────────
export const jenkinsApi = {
  list: () =>
    client.get('/settings/jenkins')
      .then((r) => (r.data.data ?? []) as JenkinsInstance[]),

  create: (data: Partial<JenkinsInstance> & { apiToken?: string; viewerToken?: string }) =>
    client.post('/settings/jenkins', data).then(unwrap<JenkinsInstance>),

  update: (id: string, data: Partial<JenkinsInstance> & { apiToken?: string; viewerToken?: string }) =>
    client.put(`/settings/jenkins/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    client.delete(`/settings/jenkins/${id}`).then((r) => r.data),

  ping: (id: string) =>
    client.post(`/settings/jenkins/${id}/ping`)
      .then((r) => r.data.data as { status: string; version?: string; latencyMs?: number }),

  syncAgents: (id: string) =>
    client.post(`/settings/jenkins/${id}/sync-agents`).then((r) => r.data.data as { synced: number; totalNodes: number }),

  listLabels: (instanceId?: string) =>
    client.get('/settings/agent-labels', { params: { instanceId } })
      .then((r) => (r.data.data ?? []) as AgentLabel[]),

  listAgentNodes: (params?: { instanceId?: string; keyword?: string }) =>
    client.get('/settings/agent-nodes', { params })
      .then((r) => (r.data.data ?? []) as AgentNode[]),

  listNodes: (labelId: string) =>
    client.get(`/settings/agent-labels/${labelId}/nodes`)
      .then((r) => (r.data.data ?? []) as AgentNode[]),
}

// ── Global vars ───────────────────────────────────────────────────────────
export const varsApi = {
  list: (scope?: string) =>
    client.get('/settings/vars', { params: { scope } })
      .then((r) => (r.data.data ?? []) as GlobalVar[]),

  create: (data: Partial<GlobalVar>) =>
    client.post('/settings/vars', data).then(unwrap<GlobalVar>),

  update: (id: string, data: Partial<GlobalVar>) =>
    client.put(`/settings/vars/${id}`, data).then(unwrap<GlobalVar>),

  delete: (id: string) =>
    client.delete(`/settings/vars/${id}`).then((r) => r.data),
}
