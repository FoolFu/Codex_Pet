const fs = require('fs');
const os = require('os');
const path = require('path');

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getDefaultCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function loadPetConfig(app) {
  const appRoot = app.getAppPath();
  const userDataPath = app.getPath('userData');
  const userConfigPath = path.join(userDataPath, 'pet-config.json');
  const userOverrides = readJsonIfExists(userConfigPath) || {};
  const isDev =
    !app.isPackaged ||
    process.env.QQPET_DEV === '1' ||
    process.argv.includes('--qqpet-dev');

  return {
    appRoot,
    userDataPath,
    isDev,
    watcherEnabled: true,
    visiblePollMs: 15000,
    hiddenPollMs: 60000,
    visibleUsagePollMs: 120000,
    hiddenUsagePollMs: 300000,
    sessionListCacheMs: 30000,
    usageSessionLimit: 40,
    staleAfterMs: 120000,
    bubbleCooldownMs: 12000,
    sessionReadTailBytes: 256 * 1024,
    usageReadTailBytes: 128 * 1024,
    runtimeCacheFlushMs: 1500,
    usageCacheFlushMs: 3000,
    codexHome: getDefaultCodexHome(),
    sessionsRoot: null,
    sessionIndexPath: null,
    globalStatePath: null,
    debugPanelEnabled: isDev,
    debugLogEnabled: isDev,
    mockStateEnabled: isDev,
    ...userOverrides,
  };
}

module.exports = {
  getDefaultCodexHome,
  loadPetConfig,
  readJsonIfExists,
};
