import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WebApiAccount } from '@/api/http-client'

export const useAuthStore = defineStore('auth', () => {
  const account = ref<WebApiAccount | null>(null)
  const checked = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

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

  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      account.value = await window.api.auth.login(username, password)
      checked.value = true
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function register(username: string, password: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await window.api.auth.register(username, password)
      // Registration does not establish a session, so log straight in.
      account.value = await window.api.auth.login(username, password)
      checked.value = true
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await window.api.auth.logout()
    } finally {
      account.value = null
    }
  }

  return { account, checked, loading, error, isAuthenticated, isAdmin, restore, login, register, logout }
})
