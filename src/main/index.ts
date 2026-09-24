import 'reflect-metadata'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { MarketplaceService } from './modules/marketplace/marketplace.service'
import { SyncService } from './modules/marketplace/sync.service'

// Disable hardware acceleration for Linux headless / VM (fixes GPU process isn't usable)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor')
app.commandLine.appendSwitch('use-gl', 'swiftshader')

let mainWindow: BrowserWindow | null = null
let nestApp: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Fallback if ready-to-show never fires (GPU/headless)
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show() }, 2000)
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[main] did-fail-load', code, desc, url))
  mainWindow.webContents.on('did-finish-load', () => console.log('[main] did-finish-load', mainWindow?.webContents.getURL()))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Auto-open DevTools in dev for API debugging
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

async function bootstrapNest() {
  // Point TypeORM DB to Electron userData in production, ensure dir exists
  const dbPath = !is.dev && !process.env.GHOSTMPLAY_DB ? join(app.getPath('userData'), 'ghostmplay.db') : process.env.GHOSTMPLAY_DB
  if (dbPath && dbPath !== ':memory:' && !is.dev) {
    process.env.GHOSTMPLAY_DB = dbPath
    try { mkdirSync(dirname(dbPath), { recursive: true }) } catch {}
  } else if (dbPath && dbPath !== ':memory:') {
    // dev: ensure cwd dir writable, create ghostmplay.db parent if needed
    try { mkdirSync(dirname(join(process.cwd(), dbPath)), { recursive: true }) } catch {}
  }
  console.log('[main] GHOSTMPLAY_DB =', process.env.GHOSTMPLAY_DB ?? join(process.cwd(), 'ghostmplay.db'))
  nestApp = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error', 'debug'] })
  await nestApp.init()
  console.log('[main] Nest init OK')

  const marketplace = nestApp.get(MarketplaceService)
  const sync = nestApp.get(SyncService)

  const shouldLog = () => process.env.LOG_API === '1' || process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1'

  ipcMain.handle('marketplace:list', async (_e, query) => {
    if (shouldLog()) console.log('[IPC] → marketplace:list', JSON.stringify(query))
    const res = await marketplace.list(query)
    if (shouldLog()) console.log('[IPC] ← marketplace:list', `total=${res.total} returned=${(res.data as unknown[]).length}`)
    return res
  })
  ipcMain.handle('marketplace:get', async (_e, tokenId: number) => {
    if (shouldLog()) console.log('[IPC] → marketplace:get', tokenId)
    const res = await marketplace.getByTokenId(tokenId)
    if (shouldLog()) console.log('[IPC] ← marketplace:get', res ? 'found' : 'null')
    return res
  })
  ipcMain.handle('marketplace:filters', async () => {
    if (shouldLog()) console.log('[IPC] → marketplace:filters')
    const res = await marketplace.getDistinctFilters()
    if (shouldLog()) console.log('[IPC] ← marketplace:filters', JSON.stringify(res))
    return res
  })
  ipcMain.handle('marketplace:equipmentTypes', async () => {
    if (shouldLog()) console.log('[IPC] → marketplace:equipmentTypes')
    return marketplace.getDistinctEquipmentTypes()
  })
  ipcMain.handle('marketplace:gradeEffects', async () => {
    if (shouldLog()) console.log('[IPC] → marketplace:gradeEffects')
    return marketplace.getDistinctGradeEffects()
  })
  ipcMain.handle('favorites:list', async () => {
    if (shouldLog()) console.log('[IPC] → favorites:list')
    const res = await marketplace.listFavorites()
    if (shouldLog()) console.log('[IPC] ← favorites:list', res.length)
    return res
  })
  ipcMain.handle('favorites:create', async (_e, input) => {
    if (shouldLog()) console.log('[IPC] → favorites:create', JSON.stringify(input))
    const res = await marketplace.createFavorite(input)
    if (shouldLog()) console.log('[IPC] ← favorites:create', JSON.stringify(res))
    return res
  })
  ipcMain.handle('favorites:update', async (_e, payload: { id: number; input: unknown }) => {
    if (shouldLog()) console.log('[IPC] → favorites:update', JSON.stringify(payload))
    const res = await marketplace.updateFavorite(payload.id, payload.input as never)
    if (shouldLog()) console.log('[IPC] ← favorites:update', JSON.stringify(res))
    return res
  })
  ipcMain.handle('favorites:delete', async (_e, id: number) => {
    if (shouldLog()) console.log('[IPC] → favorites:delete', id)
    await marketplace.deleteFavorite(id)
    if (shouldLog()) console.log('[IPC] ← favorites:delete ok')
  })
  ipcMain.handle('favorites:get', async (_e, id: number) => {
    if (shouldLog()) console.log('[IPC] → favorites:get', id)
    const res = await marketplace.getFavorite(id)
    if (shouldLog()) console.log('[IPC] ← favorites:get', JSON.stringify(res))
    return res
  })
  ipcMain.handle('sync:refresh', async (_e, opts) => {
    // opts may be {q, itemName, mode} from renderer; map to scrap
    if (shouldLog()) console.log('[IPC] → sync:refresh', JSON.stringify(opts))
    const itemName = (opts as { q?: string; itemName?: string })?.itemName ?? (opts as { q?: string })?.q
    const mode = (opts as { mode?: 'all' | 'latest' })?.mode ?? 'latest'
    const res = await sync.refresh({ itemName, mode })
    if (shouldLog()) console.log('[IPC] ← sync:refresh', JSON.stringify(res))
    return res
  })
  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\/market\.numine\.io\/games\/GhostM\/nfts\/\d+$/.test(url)) {
      throw new Error('Blocked external URL')
    }
    await shell.openExternal(url)
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.ghostmplay.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    await bootstrapNest()
  } catch (e) {
    console.error('[main] bootstrapNest failed, opening window anyway:', e)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((e) => console.error('[main] app.whenReady failed', e))

// Surface unhandled rejections that previously hung silently
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection', e))
process.on('uncaughtException', (e) => console.error('[main] uncaughtException', e))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    nestApp?.close().finally(() => app.quit())
  }
})
