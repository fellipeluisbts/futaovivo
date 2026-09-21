const { app, BrowserWindow, BrowserView, ipcMain, session, dialog } = require('electron');
const { net } = require('electron');
const AdmZip = require('adm-zip');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,UseChromeOSDirectVideoDecoder');

const MAX_TABS = 9;
const HOME_URL = 'https://www.google.com';
let mainWindow;
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let tileMode = false;
let tileSelection = new Set();
let overlayWidth = 0;
let overlayView;
let overlayKind = null;
let overlayData = null;
let installedExtensions = [];

function getBrowserSession() {
  return session.fromPartition('persist:browser');
}

function configureMediaSession(browserSession) {
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'fullscreen', 'notifications'].includes(permission));
  });
  browserSession.setPermissionCheckHandler((_webContents, permission) => ['media', 'fullscreen', 'notifications'].includes(permission));
}

function getActiveTab() {
  return tabs.find((tab) => tab.id === activeTabId);
}

function extensionRegistryPath() {
  return path.join(app.getPath('userData'), 'installed-extensions.json');
}

function extensionOptionsPage(extensionPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
    return manifest.options_ui?.page || manifest.options_page || null;
  } catch {
    return null;
  }
}

async function restoreInstalledExtensions() {
  if (!fs.existsSync(extensionRegistryPath())) return;
  try {
    const saved = JSON.parse(fs.readFileSync(extensionRegistryPath(), 'utf8'));
    for (const item of saved) {
      if (item.enabled === false) {
        installedExtensions.push(item);
        continue;
      }
      const extension = await getBrowserSession().loadExtension(item.path, { allowFileAccess: true });
      installedExtensions.push({ ...item, id: extension.id, name: extension.name || item.name, version: extension.version, enabled: true, optionsPage: item.optionsPage || extensionOptionsPage(item.path) });
    }
  } catch {
    installedExtensions = [];
  }
}

function createTab(url = HOME_URL, options = {}) {
  if (tabs.filter((tab) => !tab.settings).length >= MAX_TABS && !options.settings) return null;

  const tab = {
    id: nextTabId++,
    title: options.title || 'Nova guia',
    url,
    settings: Boolean(options.settings),
    pinned: Boolean(options.pinned),
    muted: false,
    audible: false,
    zoomFactor: 1,
    view: new BrowserView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        plugins: true,
        autoplayPolicy: 'no-user-gesture-required',
        enableBlinkFeatures: 'EncryptedMedia',
        partition: options.partition || 'persist:browser'
      }
    })
  };

  const browserSession = tab.view.webContents.session;
  configureMediaSession(browserSession);
  tab.view.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');

  tab.view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    createTab(targetUrl);
    return { action: 'deny' };
  });
  tab.view.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    tab.title = title || 'Nova guia';
    sendState();
  });
  tab.view.webContents.on('did-navigate', (_event, targetUrl) => {
    tab.url = targetUrl;
    sendState();
  });
  tab.view.webContents.on('did-navigate-in-page', (_event, targetUrl) => {
    tab.url = targetUrl;
    sendState();
  });
  tab.view.webContents.on('did-finish-load', sendState);
  tab.view.webContents.on('focus', () => {
    activeTabId = tab.id;
    updateAudioState();
    sendState();
  });
  tab.view.webContents.on('audio-state-changed', (_event, audible) => {
    tab.audible = audible;
    sendState();
  });
  tab.view.webContents.on('did-finish-load', () => {
    tab.view.webContents.insertCSS('::-webkit-scrollbar { width: 0 !important; height: 0 !important; }').catch(() => {});
  });
  tab.view.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    if (input.key !== '+' && input.key !== '=' && input.key !== '-' && input.key !== '0') return;
    event.preventDefault();
    if (input.key === '0') tab.zoomFactor = 1;
    else tab.zoomFactor = Math.min(5, Math.max(0.25, tab.zoomFactor + (input.key === '-' ? -0.1 : 0.1)));
    tab.view.webContents.setZoomFactor(tileMode ? getMosaicZoom(Math.min(tileSelection.size, 6)) : tab.zoomFactor);
  });

  tabs.push(tab);
  if (!tab.settings) tileSelection.add(tab.id);
  if (!activeTabId) activeTabId = tab.id;
  if (options.settings) tab.view.webContents.loadFile(url);
  else tab.view.webContents.loadURL(url);
  refreshBounds();
  sendState();
  return tab;
}

function closeTab(tabId) {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0 || tabs[index].pinned) return;
  const [tab] = tabs.splice(index, 1);
  tileSelection.delete(tabId);
  if (mainWindow) mainWindow.removeBrowserView(tab.view);
  tab.view.webContents.destroy();
  if (activeTabId === tabId) activeTabId = tabs[index]?.id || tabs[index - 1]?.id || null;
  refreshBounds();
  sendState();
}

function activateTab(tabId) {
  if (!tabs.some((tab) => tab.id === tabId)) return;
  activeTabId = tabId;
  updateAudioState();
  sendState();
  refreshBounds();
}

function updateAudioState() {
  tabs.forEach((tab) => {
    tab.view.webContents.setAudioMuted(tab.id !== activeTabId || tab.muted);
  });
}

function getMosaicZoom(tabCount) {
  if (tabCount <= 1) return 1;
  if (tabCount === 2) return 0.75;
  if (tabCount <= 4) return 0.7;
  return 0.6;
}

function refreshBounds() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const visibleTabs = tileMode ? tabs.filter((tab) => !tab.settings && tileSelection.has(tab.id)).slice(0, 6) : [getActiveTab()].filter(Boolean);
  const panelWidth = overlayKind === 'panel' ? 240 : 0;
  const browserWidth = Math.max(1, width - panelWidth);
  if (overlayView) mainWindow.removeBrowserView(overlayView);
  for (const tab of tabs) mainWindow.removeBrowserView(tab.view);
  if (visibleTabs.length) {
    const rows = visibleTabs.length >= 3 ? 2 : 1;
    const columns = visibleTabs.length >= 5 ? 3 : visibleTabs.length >= 2 ? 2 : 1;
    const contentHeight = Math.max(0, height - 46);
    const gap = tileMode ? 2 : 0;
    const tileWidth = (browserWidth - gap * (columns - 1)) / columns;
    const mosaicZoom = getMosaicZoom(visibleTabs.length);
    const tileHeight = (contentHeight - gap * (rows - 1)) / rows;
    visibleTabs.forEach((tab, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      mainWindow.addBrowserView(tab.view);
      tab.view.webContents.setZoomFactor(tileMode ? mosaicZoom : tab.zoomFactor);
      tab.view.setBounds({ x: Math.floor(column * (tileWidth + gap)), y: 46 + Math.floor(row * (tileHeight + gap)), width: Math.ceil(tileWidth), height: Math.ceil(tileHeight) });
      tab.view.setAutoResize({ width: true, height: true });
    });
  }
  updateAudioState();
  if (overlayView && overlayKind) {
    const isTabContext = overlayKind === 'tab-context';
    const overlayWidth = isTabContext ? 180 : overlayKind === 'favorites' ? 300 : 240;
    const overlayHeight = isTabContext ? 176 : overlayKind === 'favorites' ? 360 : Math.max(0, height - 46);
    const overlayX = isTabContext ? Math.max(8, Math.min(overlayData.x, width - overlayWidth - 8)) : overlayKind === 'favorites' ? 100 : width - overlayWidth;
    const overlayY = isTabContext ? Math.max(0, Math.min(overlayData.y, height - overlayHeight)) : 46;
    overlayView.setBounds({ x: overlayX, y: overlayY, width: overlayWidth, height: overlayHeight });
    mainWindow.addBrowserView(overlayView);
  }
}

function sendState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = getActiveTab();
  mainWindow.webContents.send('browser:state', {
    tabs: tabs.map(({ id, title, url, settings, pinned, muted, audible }) => ({ id, title, url, settings, pinned, muted, audible })),
    activeTabId,
    canGoBack: Boolean(active?.view.webContents.canGoBack()),
    canGoForward: Boolean(active?.view.webContents.canGoForward()),
    isLoading: Boolean(active?.view.webContents.isLoading()),
    tileMode,
    selectedTabIds: [...tileSelection],
    installedExtensions
  });
}

function showExtensionMenu() {
  if (overlayView) overlayView.webContents.send('overlay:extensions', installedExtensions);
}

function extensionIdFromUrl(url) {
  return url.match(/chromewebstore\.google\.com\/detail\/[^/]+\/([a-p]{32})/i)?.[1] || null;
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    const chunks = [];
    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return resolve(downloadFile(response.headers.location));
      if (response.statusCode !== 200) return reject(new Error(`Download failed: ${response.statusCode}`));
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function installCrx(url) {
  const extensionId = extensionIdFromUrl(url);
  if (!extensionId) throw new Error('Abra a página de detalhes de uma extensão da Chrome Web Store.');
  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=128.0&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;
  const crx = await downloadFile(crxUrl);
  if (crx.toString('ascii', 0, 4) !== 'Cr24') throw new Error('A Chrome Web Store não retornou um pacote CRX válido.');
  const version = crx.readUInt32LE(4);
  const zipOffset = version === 2 ? 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12) : version === 3 ? 12 + crx.readUInt32LE(8) : 0;
  if (!zipOffset || zipOffset >= crx.length) throw new Error('Formato CRX não suportado.');
  const destination = path.join(app.getPath('userData'), 'extensions', extensionId);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  new AdmZip(crx.subarray(zipOffset)).extractAllTo(destination, true);
  const extension = await getBrowserSession().loadExtension(destination, { allowFileAccess: true });
  const item = { id: extension.id, name: extension.name || extensionId, version: extension.version, path: destination, enabled: true, optionsPage: extensionOptionsPage(destination) };
  installedExtensions = [...installedExtensions.filter((entry) => entry.id !== item.id), item];
  fs.writeFileSync(extensionRegistryPath(), JSON.stringify(installedExtensions, null, 2));
  sendState();
  return item;
}

function navigate(value) {
  const active = getActiveTab();
  if (!active) return;
  let target = value.trim();
  if (!target) return;
  if (!/^https?:\/\//i.test(target)) {
    target = target.includes('.') && !target.includes(' ') ? `https://${target}` : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }
  active.view.webContents.loadURL(target);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    backgroundColor: '#101820',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('resize', refreshBounds);
  mainWindow.on('maximize', refreshBounds);
  mainWindow.on('unmaximize', refreshBounds);
  createTab();
}

app.whenReady().then(async () => {
  await restoreInstalledExtensions();
  createWindow();
  ipcMain.on('browser:navigate', (_event, value) => navigate(value));
  ipcMain.on('browser:new-tab', () => createTab());
  ipcMain.on('browser:activate-tab', (_event, id) => activateTab(id));
  ipcMain.on('browser:close-tab', (_event, id) => closeTab(id));
  ipcMain.on('browser:back', () => getActiveTab()?.view.webContents.goBack());
  ipcMain.on('browser:forward', () => getActiveTab()?.view.webContents.goForward());
  ipcMain.on('browser:reload', () => getActiveTab()?.view.webContents.reload());
  ipcMain.on('browser:toggle-tile', (_event, selectedIds) => {
    tileSelection = new Set(selectedIds);
    tileMode = !tileMode;
    refreshBounds();
    sendState();
  });
  ipcMain.on('browser:set-tile-selection', (_event, selectedIds) => {
    tileSelection = new Set(selectedIds);
    if (tileMode) refreshBounds();
  });
  ipcMain.on('browser:tab-action', (_event, tabId, action) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (action === 'pin') {
      tab.pinned = !tab.pinned;
      tabs.sort((left, right) => Number(right.pinned) - Number(left.pinned));
    }
    if (action === 'mute') tab.muted = !tab.muted;
    if (action === 'duplicate') createTab(tab.url, { title: tab.title, pinned: tab.pinned });
    if (action === 'close-right') {
      const rightTabs = tabs.slice(tabs.findIndex((item) => item.id === tabId) + 1).filter((item) => !item.pinned);
      rightTabs.forEach((item) => closeTab(item.id));
      return;
    }
    updateAudioState();
    sendState();
  });
  ipcMain.on('browser:reorder-tabs', (_event, orderedIds) => {
    const positions = new Map(orderedIds.map((id, index) => [id, index]));
    const movable = tabs.filter((tab) => !tab.pinned);
    movable.sort((left, right) => (positions.get(left.id) ?? tabs.length) - (positions.get(right.id) ?? tabs.length));
    tabs = [...tabs.filter((tab) => tab.pinned), ...movable];
    refreshBounds();
    sendState();
  });
  ipcMain.on('browser:set-overlay-width', (_event, width) => { overlayWidth = Math.max(0, Number(width) || 0); });
  ipcMain.on('browser:toggle-overlay', (_event, kind, data) => {
    if (!overlayView) {
      overlayView = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
      mainWindow.addBrowserView(overlayView);
      overlayView.webContents.on('did-finish-load', () => {
        if (overlayKind) overlayView.webContents.send('overlay:show', overlayKind, overlayData);
      });
      overlayView.webContents.loadFile('overlay.html');
    }
    overlayKind = overlayKind === kind ? null : kind;
    overlayData = data || null;
    if (overlayKind) {
      const [, height] = mainWindow.getContentSize();
      const isTabContext = overlayKind === 'tab-context';
      const overlayWidth = isTabContext ? 180 : overlayKind === 'favorites' ? 300 : 240;
      const overlayHeight = isTabContext ? 176 : overlayKind === 'favorites' ? 360 : Math.max(0, height - 46);
      const overlayX = isTabContext ? data.x : overlayKind === 'favorites' ? 100 : mainWindow.getContentSize()[0] - overlayWidth;
      const overlayY = isTabContext ? data.y : 46;
      overlayView.setBounds({ x: overlayX, y: overlayY, width: overlayWidth, height: overlayHeight });
      mainWindow.removeBrowserView(overlayView);
      mainWindow.addBrowserView(overlayView);
      overlayView.webContents.send('overlay:show', overlayKind, overlayData);
      refreshBounds();
    } else {
      mainWindow.removeBrowserView(overlayView);
      refreshBounds();
    }
  });
  ipcMain.on('browser:show-overlay', (_event, kind, data) => {
    if (!overlayView) {
      overlayView = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
      overlayView.webContents.on('did-finish-load', () => {
        if (overlayKind) overlayView.webContents.send('overlay:show', overlayKind, overlayData);
      });
      overlayView.webContents.loadFile('overlay.html');
    }
    overlayKind = kind;
    overlayData = data || null;
    refreshBounds();
    overlayView.webContents.send('overlay:show', overlayKind, overlayData);
  });
  ipcMain.on('browser:update-overlay-data', (_event, data) => {
    overlayData = data;
    if (overlayView && overlayKind) overlayView.webContents.send('overlay:show', overlayKind, overlayData);
  });
  ipcMain.on('browser:favorite-action', (_event, action, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('favorites:action', action, data);
  });
  ipcMain.on('browser:close-overlay', () => {
    overlayKind = null;
    if (overlayView) mainWindow.removeBrowserView(overlayView);
    refreshBounds();
  });
  ipcMain.on('browser:overlay-action', (_event, action) => {
    if (action === 'settings') {
      const existing = tabs.find((tab) => tab.settings);
      return existing ? activateTab(existing.id) : createTab(path.join(__dirname, 'settings.html'), { settings: true, title: 'Configurações' });
    }
    if (action === 'devtools') return getActiveTab()?.view.webContents.toggleDevTools();
    if (action === 'clear-current') return getActiveTab()?.view.webContents.session.clearStorageData({ storages: ['cookies'] });
    if (action === 'clear-all') return Promise.all(tabs.map((tab) => tab.view.webContents.session.clearStorageData({ storages: ['cookies'] })));
    if (action === 'extensions') return showExtensionMenu();
  });
  ipcMain.handle('extensions:list', () => installedExtensions);
  ipcMain.handle('extensions:install', async (_event, url) => {
    if (url) return installCrx(url);
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Selecionar extensão descompactada' });
    if (result.canceled || !result.filePaths[0]) return installedExtensions;
    const extension = await getBrowserSession().loadExtension(result.filePaths[0], { allowFileAccess: true });
    const item = { id: extension.id, name: extension.name || path.basename(result.filePaths[0]), version: extension.version, path: result.filePaths[0], enabled: true, optionsPage: extensionOptionsPage(result.filePaths[0]) };
    installedExtensions = [...installedExtensions.filter((entry) => entry.id !== item.id), item];
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(extensionRegistryPath(), JSON.stringify(installedExtensions, null, 2));
    sendState();
    return installedExtensions;
  });
  ipcMain.handle('extensions:toggle', async (_event, id) => {
    const item = installedExtensions.find((extension) => extension.id === id);
    if (!item) return installedExtensions;
    if (item.enabled === false) {
      const extension = await getBrowserSession().loadExtension(item.path, { allowFileAccess: true });
      item.id = extension.id;
      item.enabled = true;
    } else {
      getBrowserSession().removeExtension(item.id);
      item.enabled = false;
    }
    fs.writeFileSync(extensionRegistryPath(), JSON.stringify(installedExtensions, null, 2));
    sendState();
    return installedExtensions;
  });
  ipcMain.handle('extensions:remove', async (_event, id) => {
    const item = installedExtensions.find((extension) => extension.id === id);
    if (item?.enabled !== false) getBrowserSession().removeExtension(id);
    installedExtensions = installedExtensions.filter((extension) => extension.id !== id);
    fs.writeFileSync(extensionRegistryPath(), JSON.stringify(installedExtensions, null, 2));
    sendState();
    return installedExtensions;
  });
  ipcMain.handle('extensions:options', (_event, id) => {
    const extension = installedExtensions.find((item) => item.id === id);
    if (!extension?.optionsPage) return false;
    createTab(`chrome-extension://${extension.id}/${extension.optionsPage}`, { title: `${extension.name} - Opções` });
    return true;
  });
  ipcMain.on('browser:toggle-devtools', () => getActiveTab()?.view.webContents.toggleDevTools());
  ipcMain.on('window:minimize', () => mainWindow.minimize());
  ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  ipcMain.on('window:close', () => mainWindow.close());
  ipcMain.handle('browser:clear-cookies', async (_event, tabId) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (tab) await tab.view.webContents.session.clearStorageData({ storages: ['cookies'] });
    return true;
  });
  ipcMain.handle('browser:clear-all-cookies', async () => {
    await getBrowserSession().clearStorageData({ storages: ['cookies'] });
    await Promise.all(tabs.map((tab) => tab.view.webContents.session.clearStorageData({ storages: ['cookies'] })));
    return true;
  });
  ipcMain.handle('browser:open-settings', () => {
    const existing = tabs.find((tab) => tab.settings);
    if (existing) return activateTab(existing.id);
    return createTab(path.join(__dirname, 'settings.html'), { settings: true, title: 'Configurações' });
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
