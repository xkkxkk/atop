import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'

interface AuthState {
  user:            User | null
  accessToken:     string | null
  isAuthenticated: boolean
  mustChangePwd:   boolean
  setAuth:         (user: User, accessToken: string, mustChangePwd?: boolean) => void
  updateUser:      (patch: Partial<User>) => void
  setAccessToken:  (token: string) => void
  clearAuth:       () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user:            null,
      accessToken:     null,
      isAuthenticated: false,
      mustChangePwd:   false,

      setAuth: (user, accessToken, mustChangePwd) =>
        set({ user, accessToken, isAuthenticated: true, mustChangePwd: mustChangePwd ?? false }),

      updateUser: (patch) =>
        set((state) => ({ user: state.user ? { ...state.user, ...patch } : state.user })),

      setAccessToken: (token) =>
        set({ accessToken: token }),

      clearAuth: () =>
        set({ user: null, accessToken: null, isAuthenticated: false, mustChangePwd: false }),
    }),
    {
      name: 'atop-auth',
      partialize: (s) => ({
        user:            s.user,
        accessToken:     s.accessToken,
        isAuthenticated: s.isAuthenticated,
        mustChangePwd:   s.mustChangePwd,
      }),
    },
  ),
)
