<template>
  <div class="page">
    <h1>GhostMPlay</h1>
    <p>Windows desktop — Vue + Electron + NestJS + TypeORM (better-sqlite3). Direct API hit (no scraper).</p>
    <p class="hint">Configure <code>GHOSTMPLAY_API_BASE</code> + <code>GHOSTMPLAY_API_HEADERS_JSON</code> in main env once you paste DevTools curl.</p>
    <router-link class="cta" to="/marketplace">Browse marketplace →</router-link>
  </div>
</template>
<style scoped>
.page{padding:28px; max-width:880px}
.hint{color:#9aa3b2; font-size:13px}
.cta{display:inline-block; margin-top:16px; padding:10px 14px; background:#1e2533; border:1px solid #2a3447; border-radius:10px}
code{background:#1e2533; padding:2px 6px; border-radius:6px}
</style>
