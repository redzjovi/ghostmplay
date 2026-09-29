<template>
  <div class="min-h-screen bg-background text-foreground grid place-items-center px-4">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle class="text-xl">{{ isRegister ? 'Create an account' : 'Sign in' }}</CardTitle>
        <CardDescription>
          {{ isRegister ? 'Save favorite searches and follow the market.' : 'Sign in to reach your saved searches.' }}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="username">Username</label>
            <Input
              id="username"
              v-model="username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              :disabled="auth.loading"
              placeholder="lowercase, 3-32 characters"
            />
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="password">Password</label>
            <Input
              id="password"
              v-model="password"
              type="password"
              :autocomplete="isRegister ? 'new-password' : 'current-password'"
              :disabled="auth.loading"
              placeholder="at least 8 characters"
            />
          </div>

          <Alert v-if="auth.error" variant="destructive">
            <AlertDescription>{{ auth.error }}</AlertDescription>
          </Alert>

          <Button type="submit" class="w-full" :disabled="auth.loading">
            <Loader2 v-if="auth.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ isRegister ? 'Create account' : 'Sign in' }}
          </Button>

          <p class="text-center text-xs text-muted-foreground">
            <template v-if="isRegister">
              Already have an account?
              <RouterLink class="underline underline-offset-4" :to="{ name: 'login' }">Sign in</RouterLink>
            </template>
            <template v-else>
              No account yet?
              <RouterLink class="underline underline-offset-4" :to="{ name: 'register' }">Create one</RouterLink>
            </template>
          </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// One component serves both routes; the name decides the copy and the call.
const isRegister = computed(() => route.name === 'register')

const username = ref('')
const password = ref('')

async function submit() {
  const next = typeof route.query.next === 'string' ? route.query.next : '/marketplaces/list'
  try {
    if (isRegister.value) {
      await auth.register(username.value.trim(), password.value)
    } else {
      await auth.login(username.value.trim(), password.value)
    }
    await router.replace(next)
  } catch {
    // The store already surfaced the message; keep the form mounted.
  }
}
</script>
