<template>
  <div class="max-w-3xl mx-auto p-7">
    <Card>
      <CardHeader>
        <CardTitle>GhostMPlay</CardTitle>
        <CardDescription>Windows desktop — Vue + Electron + NestJS + TypeORM (sql.js). Direct API hit.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <Alert>
          <AlertDescription>Configure <code class="bg-muted px-1.5 py-0.5 rounded text-xs">GHOSTMPLAY_API_BASE</code> + <code class="bg-muted px-1.5 py-0.5 rounded text-xs">GHOSTMPLAY_API_HEADERS_JSON</code> in main env once you paste DevTools curl.</AlertDescription>
        </Alert>
        <Button as-child>
          <router-link to="/marketplace">Browse marketplace →</router-link>
        </Button>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
</script>
