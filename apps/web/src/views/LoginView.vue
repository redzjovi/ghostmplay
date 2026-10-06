<template>
  <div class="min-h-screen bg-background text-foreground grid place-items-center px-4">
    <Card class="w-full max-w-[400px] rounded-2xl shadow-sm dark:bg-secondary">
      <CardHeader class="items-center p-6 pb-5 text-center sm:p-8 sm:pb-6">
        <CardTitle class="text-xl leading-tight">Log in or sign up</CardTitle>
      </CardHeader>

      <CardContent class="sm:p-8 sm:pt-0">
        <!-- Google is the only way in: no username, no password, no register. -->
        <div v-if="googleEnabled">
          <Button variant="outline" class="h-11 w-full gap-3 rounded-lg" @click="startGoogle">
            <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.5 5.5 0 0 1-2.39 3.62v3h3.86c2.26-2.08 3.58-5.15 3.58-8.81Z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3c-1.08.72-2.45 1.15-4.08 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
              <path fill="#FBBC05" d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z" />
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.86 8.87 4.75 12 4.75Z" />
            </svg>
            Continue with Google
          </Button>
        </div>

        <!-- There is no second sign-in method to fall back to, so an unconfigured
             deployment must say so rather than render an empty card. -->
        <Alert v-else>
          <AlertDescription>
            Google sign-in is not available on this deployment. Set
            <span class="font-mono">GOOGLE_CLIENT_ID</span>,
            <span class="font-mono">GOOGLE_CLIENT_SECRET</span> and
            <span class="font-mono">GOOGLE_REDIRECT_URI</span> to enable it.
          </AlertDescription>
        </Alert>

        <Alert v-if="message" variant="destructive" class="mt-3">
          <AlertDescription>{{ message }}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()

const googleEnabled = ref(false)

/**
 * Codes the API redirects back with on a failed Google attempt. Mapped to copy
 * rather than shown raw, so nothing from Google or from an exception reaches the
 * UI unescaped.
 */
const GOOGLE_ERRORS: Record<string, string> = {
  oauth_denied: 'Google sign-in was cancelled.',
  oauth_state: 'That sign-in link expired or could not be verified. Please try again.',
  oauth_unverified: 'That Google account has no verified email address.',
  oauth_throttled: 'Too many sign-in attempts from this network. Please try again shortly.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  oauth_disabled: 'Google sign-in is not available.',
}

/** Errors come only from the redirect now — there is no form to fail. */
const message = computed(() => {
  const code = typeof route.query.oauth === 'string' ? route.query.oauth : ''
  return code ? GOOGLE_ERRORS[code] ?? GOOGLE_ERRORS.oauth_failed : null
})

onMounted(async () => {
  googleEnabled.value = await auth.googleEnabled()
})

/**
 * Hands off to Google. `next` rides through the query so the callback can return
 * the visitor to wherever the guard interrupted them; the API validates it and
 * falls back to the marketplace list if it is not a same-origin path.
 */
function startGoogle() {
  const next = typeof route.query.next === 'string' ? route.query.next : undefined
  window.location.assign(window.api.auth.googleStartUrl(next))
}
</script>
