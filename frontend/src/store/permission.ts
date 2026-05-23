import { create } from 'zustand'
import type { PermissionMap } from '@/api/permission'

interface PermissionState {
  perms:    PermissionMap
  loaded:   boolean
  setPerms: (p: PermissionMap) => void
  clear:    () => void
  can:      (resource: string, action: string) => boolean
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  perms:  {},
  loaded: false,

  setPerms: (p) => set({ perms: p, loaded: true }),

  clear: () => set({ perms: {}, loaded: false }),

  can: (resource, action) => {
    const { perms } = get()
    return perms[resource]?.[action] === true
  },
}))
