// Electron 主进程：桌面壳、内置浏览器（登录 + 抓取）、本地接口服务。
import { app, BrowserWindow, Menu, shell, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.js'
import * as live from './live.js'
import * as im from './im.js'
import * as fish from './fish.js'
import { startServer } from './server.js'
import { initCapabilities } from './capabilities.js'
import { initImageGeneration } from './image-generation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.DY_DEV_URL || ''
const PORT = Number(process.env.DY_PORT) || 0

// 有头 Chromium 才能正常解码视频与维持后台轮询；同时去掉 UA 里的 Electron 标识。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}/\\S+`), '')

let mainWin = null
let stageWin = null
let server = null

function showStageWindow() {
  if (stageWin && !stageWin.isDestroyed()) { stageWin.show(); stageWin.focus(); return }
  stageWin = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 800,
    minHeight: 500,
    title: '小鲸直播间 · 播出画面',
    backgroundColor: '#0b1937',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  stageWin.loadURL(`${DEV_URL || `http://127.0.0.1:${server.port}/`}#/stage`)
  stageWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  stageWin.on('closed', () => { stageWin = null })
}

function createMainWindow(url) {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: '#f6f7f9',
    title: '抖音语音直播间 AI 看板',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWin.loadURL(url)
  mainWin.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  mainWin.on('closed', () => {
    mainWin = null
    app.quit()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })

  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

    const userData = app.getPath('userData')
    initCapabilities({ builtinDirectory: path.join(__dirname, 'skills'), customDirectory: path.join(userData, 'skills') })
    initImageGeneration(path.join(userData, 'generated_images'))
    db.initDb(path.join(userData, 'live_data.db'))
    fish.init(path.join(userData, 'fish_audio.json'), path.join(userData, 'voice_audio'))
    await live.init({
      agentPath: path.join(userData, 'agent_config.json'),
      defaultAgentPath: path.join(__dirname, 'default-agent-config.json'),
      aiConfigPath: path.join(userData, 'ai_config.json'),
      settle: Number(process.env.DY_SETTLE) || 12000,
    })
    im.init({
      dmAgentPath: path.join(userData, 'dm_agent.json'),
      defaultDmAgentPath: path.join(__dirname, 'default-dm-agent.json'),
    })

    server = await startServer({
      port: PORT,
      staticDir: DEV_URL ? null : path.join(__dirname, '..', 'dist'),
      stageFile: path.join(userData, 'live_stage.json'),
      showStage: showStageWindow,
    })

    // 内置浏览器与看板共用去标识 UA
    session.fromPartition('persist:douyin').setUserAgent(app.userAgentFallback)

    createMainWindow(DEV_URL || `http://127.0.0.1:${server.port}/`)
  })
}

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  im.shutdown()
  live.shutdown()
  if (server) server.close()
  db.closeDb()
})
