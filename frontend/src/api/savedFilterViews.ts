import client from './client'

export type SavedFilterView<T> = {
  id: string
  name: string
  filters: T
  createdAt: string
  updatedAt?: string
}

export const savedFilterViewApi = {
  list: <T>(scopeKey: string) =>
    client.get<{ data: { items: Array<SavedFilterView<T>> } }>('/saved-filter-views', { params: { scopeKey } })
      .then((r) => r.data.data?.items ?? []),

  save: <T>(scopeKey: string, name: string, filters: T) =>
    client.post<{ data: SavedFilterView<T> }>('/saved-filter-views', { scopeKey, name, filters })
      .then((r) => r.data.data),

  delete: (id: string) =>
    client.delete(`/saved-filter-views/${id}`).then((r) => r.data),
}
