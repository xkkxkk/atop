import useSWR from 'swr'
import { dimensionApi } from '@/api/settings'
import type { DimensionItem } from '@/types'

export function useDimensions() {
  const { data = [], isLoading } = useSWR(
    'dimension-dict-all',
    () => dimensionApi.list(),
    { revalidateOnFocus: false, dedupingInterval: 60_000 }
  )

  const items = Array.isArray(data) ? data : []

  const projects     = items.filter(d => d.dimension === 'project').sort((a, b) => a.sortOrder - b.sortOrder)
  const environments = items.filter(d => d.dimension === 'environment').sort((a, b) => a.sortOrder - b.sortOrder)
  const products     = items.filter(d => d.dimension === 'product').sort((a, b) => a.sortOrder - b.sortOrder)
  const oses         = items.filter(d => d.dimension === 'os').sort((a, b) => a.sortOrder - b.sortOrder)
  const runTypes     = items.filter(d => d.dimension === 'run_type').sort((a, b) => a.sortOrder - b.sortOrder)

  const toOptions = (list: DimensionItem[]) =>
    list.map(d => ({ label: d.displayName || d.value, value: d.value }))

  return {
    isLoading,
    projects,    projectOptions:     toOptions(projects),
    environments,environmentOptions: toOptions(environments),
    products,    productOptions:     toOptions(products),
    oses,        osOptions:          toOptions(oses),
    runTypes,    runTypeOptions:     toOptions(runTypes),
  }
}
