const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const widgetConfig = require('./widget-config');
const { loadPetConfig } = require('./pet-config');
const { PetCache } = require('./pet-cache');
const { CodexMonitor } = require('./codex-monitor');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  screen,
} = require('electron');

let mainWindow = null;
let tray = null;
let quitting = false;
let topMostTimer = null;
let localServer = null;
let localServerUrl = null;
const dragStateByWebContentsId = new Map();
let petConfig = null;
let petCache = null;
let codexMonitor = null;
const shouldCaptureStartup =
  process.env.QQPET_CAPTURE === '1' ||
  process.argv.includes('--capture-debug');
const debugLogPath = path.join(os.tmpdir(), 'qqpet-debug.log');

function debugLog(message) {
  fs.appendFileSync(
    debugLogPath,
    `[${new Date().toISOString()}] ${message}\n`,
    'utf8',
  );
}

function broadcastPetState() {
  if (!mainWindow || mainWindow.isDestroyed() || !codexMonitor) return;
  mainWindow.webContents.send('qqpet:state', codexMonitor.getSnapshot());
}

function registerPetStateIpc() {
  ipcMain.removeHandler('qqpet:get-state');
  ipcMain.removeHandler('qqpet:get-debug-state');
  ipcMain.removeHandler('qqpet:set-mock-state');

  ipcMain.handle('qqpet:get-state', () => {
    return codexMonitor ? codexMonitor.getSnapshot() : null;
  });

  ipcMain.handle('qqpet:get-debug-state', () => {
    return {
      config: petConfig,
      snapshot: codexMonitor ? codexMonitor.getSnapshot() : null,
    };
  });

  ipcMain.handle('qqpet:set-mock-state', (_event, patch) => {
    if (!codexMonitor) return null;
    return codexMonitor.setMockState(patch || null);
  });
}

if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getAppPath(), '.qqpet-userdata'));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.cur':
      return 'image/x-icon';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.swf':
      return 'application/x-shockwave-flash';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    default:
      return 'application/octet-stream';
  }
}

function startLocalServer() {
  if (localServerUrl) {
    return Promise.resolve(localServerUrl);
  }

  return new Promise((resolve, reject) => {
    const rootDir = app.getAppPath();

    localServer = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        let pathname = decodeURIComponent(requestUrl.pathname || '/');
        if (pathname === '/') pathname = '/index.html';

        const resolvedPath = path.normalize(path.join(rootDir, pathname.replace(/^\/+/, '')));
        if (!resolvedPath.startsWith(rootDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        res.writeHead(200, {
          'Content-Type': getMimeType(resolvedPath),
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(resolvedPath).pipe(res);
      } catch (error) {
        debugLog(`server error: ${error && error.stack ? error.stack : error}`);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', () => {
      const { port } = localServer.address();
      localServerUrl = `http://127.0.0.1:${port}`;
      debugLog(`local server listening at ${localServerUrl}`);
      resolve(localServerUrl);
    });
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  debugLog('single instance lock not acquired, quitting');
  app.quit();
}

function bringWindowToFront(win) {
  if (!win || win.isDestroyed()) return;

  win.show();
  win.focus();
  win.moveTop();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function ensureTopMostLoop() {
  if (topMostTimer) return;

  topMostTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.moveTop();
  }, 1200);
}

async function captureWindowSnapshot(win) {
  if (!win || win.isDestroyed()) return;

  try {
    const image = await win.webContents.capturePage();
    const capturePath = path.join(app.getPath('temp'), 'qqpet-capture.png');
    fs.writeFileSync(capturePath, image.toPNG());
    debugLog(`captured window to ${capturePath}`);
    console.log(`Captured QQPet window to ${capturePath}`);
  } catch (error) {
    debugLog(`capture failed: ${error && error.stack ? error.stack : error}`);
    console.error('capture failed', error);
  }
}

function registerWindowDragHandlers() {
  ipcMain.removeAllListeners('qqpetwidget:drag-start');
  ipcMain.removeAllListeners('qqpetwidget:drag-move');
  ipcMain.removeAllListeners('qqpetwidget:drag-end');
  ipcMain.removeAllListeners('qqpetwidget:content-size');
  ipcMain.removeAllListeners('qqpetwidget:set-ignore-mouse');

  const toDipPoint = point => {
    try {
      if (typeof screen.screenToDipPoint === 'function') {
        return screen.screenToDipPoint(point);
      }
    } catch {}
    return point;
  };

  ipcMain.on('qqpetwidget:drag-start', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const bounds = win.getBounds();
    const cursor = toDipPoint(screen.getCursorScreenPoint());
    dragStateByWebContentsId.set(event.sender.id, {
      startX: bounds.x,
      startY: bounds.y,
      cursorX: cursor.x,
      cursorY: cursor.y,
    });
  });

  ipcMain.on('qqpetwidget:drag-move', event => {
    const dragState = dragStateByWebContentsId.get(event.sender.id);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!dragState || !win) return;

    const cursor = toDipPoint(screen.getCursorScreenPoint());
    const nextX = Math.round(
      dragState.startX + (cursor.x - dragState.cursorX),
    );
    const nextY = Math.round(
      dragState.startY + (cursor.y - dragState.cursorY),
    );
    win.setPosition(nextX, nextY);

    dragState.startX = nextX;
    dragState.startY = nextY;
    dragState.cursorX = cursor.x;
    dragState.cursorY = cursor.y;
  });

  ipcMain.on('qqpetwidget:drag-end', event => {
    dragStateByWebContentsId.delete(event.sender.id);
  });

  ipcMain.on('qqpetwidget:set-ignore-mouse', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !payload) return;
    const ignore = Boolean(payload.ignore);
    win.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.on('qqpetwidget:content-size', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !payload) return;
    if (widgetConfig.sizeOverride) return;
    if (dragStateByWebContentsId.has(event.sender.id)) return;

    const width = Math.max(1, Math.round(payload.width || 0));
    const height = Math.max(1, Math.round(payload.height || 0));
    if (!width || !height) return;

    const { workArea } = screen.getPrimaryDisplay();
    const offsetLeft = Math.round(payload.offsetLeft || 0);
    const offsetTop = Math.round(payload.offsetTop || 0);
    const x = Math.round(
      workArea.x +
        workArea.width -
        width -
        (widgetConfig.marginX || 0) -
        offsetLeft,
    );
    const y = Math.round(
      workArea.y +
        workArea.height -
        height -
        (widgetConfig.marginY || 0) -
        offsetTop,
    );

    win.setBounds({
      x: Math.max(workArea.x, x),
      y: Math.max(workArea.y, y),
      width,
      height,
    });
    win.setResizable(false);
    bringWindowToFront(win);
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const initialSize = widgetConfig.sizeOverride || { width: 360, height: 360 };
  const initialWidth = Math.max(1, Math.round(initialSize.width));
  const initialHeight = Math.max(1, Math.round(initialSize.height));
  const initialX =
    workArea.x + workArea.width - initialWidth - (widgetConfig.marginX || 0);
  const initialY =
    workArea.y + workArea.height - initialHeight - (widgetConfig.marginY || 0);
  const win = new BrowserWindow({
    x: Math.max(workArea.x, Math.round(initialX)),
    y: Math.max(workArea.y, Math.round(initialY)),
    width: initialWidth,
    height: initialHeight,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setSkipTaskbar(true);

  const loadTarget = `${localServerUrl}/?widget=1`;
  debugLog(`loading ${loadTarget} capture=${shouldCaptureStartup}`);
  win.loadURL(loadTarget);

  win.webContents.on('did-start-loading', () => debugLog('did-start-loading fired'));
  win.webContents.on('dom-ready', () => debugLog('dom-ready fired'));
  win.webContents.on('did-stop-loading', () => debugLog('did-stop-loading fired'));

  win.once('did-finish-load', () => {
    debugLog('did-finish-load fired');
    bringWindowToFront(win);
    ensureTopMostLoop();

    if (shouldCaptureStartup) {
      setTimeout(() => captureWindowSnapshot(win), 12000);
    }
  });

  win.once('ready-to-show', () => {
    debugLog('ready-to-show fired');
    bringWindowToFront(win);
  });

  if (shouldCaptureStartup) {
    setTimeout(() => {
      debugLog('startup fallback timer fired');
      bringWindowToFront(win);
      captureWindowSnapshot(win);
    }, 15000);
  }

  win.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('blur', () => {
    if (!quitting) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
  });

  win.on('show', () => {
    if (codexMonitor) {
      codexMonitor.setWindowVisible(true);
      broadcastPetState();
    }
  });

  win.on('hide', () => {
    if (codexMonitor) {
      codexMonitor.setWindowVisible(false);
    }
  });

  mainWindow = win;
  return win;
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), '3.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip('QQPetWidget');

  const applyAutoLaunchSetting = enabled => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: false,
      });
    } catch (error) {
      debugLog(
        `setLoginItemSettings failed: ${error && error.stack ? error.stack : error}`,
      );
    }
  };

  const getAutoLaunchEnabled = () => {
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  };

  const toggleWindow = () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示/隐藏',
        click: toggleWindow,
      },
      {
        label: '开机自启动',
        type: 'checkbox',
        checked: getAutoLaunchEnabled(),
        click: menuItem => {
          applyAutoLaunchSetting(Boolean(menuItem.checked));
        },
      },
      {
        type: 'separator',
      },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on('double-click', toggleWindow);
}

app.whenReady().then(() => {
  petConfig = loadPetConfig(app);
  petCache = new PetCache(app);
  codexMonitor = new CodexMonitor({
    config: petConfig,
    cache: petCache,
  });
  codexMonitor.on('state', () => broadcastPetState());
  registerPetStateIpc();

  startLocalServer()
    .then(() => {
      registerWindowDragHandlers();
      createWindow();
      createTray();
      ensureTopMostLoop();
      codexMonitor.start();
      codexMonitor.setWindowVisible(mainWindow ? mainWindow.isVisible() : true);
      broadcastPetState();
    })
    .catch(error => {
      debugLog(`failed to start local server: ${error && error.stack ? error.stack : error}`);
      console.error('failed to start local server', error);
      app.quit();
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      bringWindowToFront(mainWindow);
    }
  });
});

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  bringWindowToFront(mainWindow);
});

app.on('before-quit', () => {
  quitting = true;
  if (topMostTimer) {
    clearInterval(topMostTimer);
    topMostTimer = null;
  }
  if (codexMonitor) {
    codexMonitor.stop();
    codexMonitor = null;
  }
  if (localServer) {
    localServer.close();
    localServer = null;
    localServerUrl = null;
  }
});

app.on('window-all-closed', event => {
  if (!quitting) {
    event.preventDefault();
  }
});
