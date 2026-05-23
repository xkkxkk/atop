import client from './client'

export const preferenceApi = {
  get: <T>(key: string) =>
    client.get<{ data: { key: string; value: T | null } }>(`/users/me/preferences/${encodeURIComponent(key)}`)
      .then((r) => r.data.data?.value ?? null),

  save: <T>(key: string, value: T) =>
    client.put<{ data: { key: string; value: T } }>(`/users/me/preferences/${encodeURIComponent(key)}`, { value })
      .then((r) => r.data.data?.value),
}
