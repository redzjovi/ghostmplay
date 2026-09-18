import 'reflect-metadata'
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { MarketplaceService } from './modules/marketplace/marketplace.service'
import { SyncService } from './modules/marketplace/sync.service'

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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrapNest() {
  // Point TypeORM DB to Electron userData in production
  if (!is.dev && !process.env.GHOSTMPLAY_DB) {
    process.env.GHOSTMPLAY_DB = join(app.getPath('userData'), 'ghostmplay.db')
  }
  nestApp = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] })
  await nestApp.init()

  const marketplace = nestApp.get(MarketplaceService)
  const sync = nestApp.get(SyncService)

  ipcMain.handle('marketplace:list', async (_e, query) => marketplace.list(query))
  ipcMain.handle('marketplace:get', async (_e, tokenId: number) => marketplace.getByTokenId(tokenId))
  ipcMain.handle('sync:refresh', async (_e, opts) => sync.refresh(opts))
  ipcMain.handle('system:ping', async () => 'pong')
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.ghostmplay.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  await bootstrapNest()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    nestApp?.close().finally(() => app.quit())
  }
})
