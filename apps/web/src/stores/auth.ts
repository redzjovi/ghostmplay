import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WebApiAccount } from '@/api/http-client'

export const useAuthStore = defineStore('auth', () => {
  const account = ref<WebApiAccount | null>(null)
  const checked = ref(false)

  const isAuthenticated = computed(() => account.value !== null)
  const isAdmin = computed(() => account.value?.role === 'admin')

  /**
   * Resolves the session once per page load. `checked` guards against a second
   * /auth/me on every navigation, which would otherwise flash the login screen.
   */
  async function restore(): Promise<void> {
    if (checked.value) return
    try {
      account.value = await window.api.auth.me()
    } catch {
      account.value = null
    } finally {
      checked.value = true
    }
  }

  async function logout(): Promise<void> {
    try {
      await window.api.auth.logout()
    } finally {
      account.value = null
    }
  }

  /**
   * Which sign-in methods the server offers. Only the login page needs this, and it
   * deliberately does not mark `checked` — this is configuration, not session state.
   */
  async function googleEnabled(): Promise<boolean> {
    try {
      return await window.api.auth.googleEnabled()
    } catch {
      // If the probe fails the button is hidden, which is the safe direction: a
      // broken /providers must not offer a sign-in that cannot complete.
      return false
    }
  }

  return { account, checked, isAuthenticated, isAdmin, restore, logout, googleEnabled }
})
