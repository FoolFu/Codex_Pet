const fs = require('fs');
const { EventEmitter } = require('events');
const { resolveCodexPaths } = require('./codex-paths');
const {
  readSessionIndex,
  resolveActiveSession,
  walkJsonlFiles,
} = require('./codex-session-resolver');
const { CodexEventReader } = require('./codex-event-reader');
const { collectUsageSnapshot } = require('./codex-usage-reader');
const { PetStore } = require('./pet-store');

class CodexMonitor extends EventEmitter {
  constructor(options) {
    super();
    this.config = options.config;
    this.cache = options.cache;
    this.store = new PetStore(this.config);
    this.reader = new CodexEventReader({
      maxInitialReadBytes: this.config.sessionReadTailBytes,
    });
    this.currentPaths = null;
    this.currentSession = null;
    this.currentOffset = 0;
    this.watchers = [];
    this.pollTimer = null;
    this.windowVisible = true;
    this.mockState = null;
    this.lastUsageRefreshAt = 0;
    this.usageFileCache = new Map();
    this.sessionFilesCache = null;
    this.sessionIndexCache = null;
    this.runtimeCacheSnapshot = null;

    this.store.on('update', snapshot => {
      this.runtimeCacheSnapshot = {
        currentSession: this.currentSession,
        offset: this.currentOffset,
        snapshot,
      };
      this.cache.setRuntimeCache(
        this.runtimeCacheSnapshot,
        this.config.runtimeCacheFlushMs,
      );
      this.emit('state', this.getSnapshot());
    });
  }

  start() {
    const runtimeCache = this.cache.getRuntimeCache();
    this.runtimeCacheSnapshot = runtimeCache || {};
    const usageCache = this.cache.getUsageCache();
    if (runtimeCache?.snapshot) {
      this.store.loadCachedSnapshot(runtimeCache.snapshot);
    }
    if (usageCache?.windows) {
      this.store.setUsageSnapshot(usageCache);
    }

    this.refresh('startup', true);
    this.armPolling();
  }

  stop() {
    this.clearWatchers();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  setWindowVisible(visible) {
    this.windowVisible = Boolean(visible);
    this.armPolling();
  }

  setMockState(patch) {
    if (!this.config.mockStateEnabled) return this.getSnapshot();
    this.mockState = patch ? { ...(this.mockState || {}), ...patch } : null;
    this.emit('state', this.getSnapshot());
    return this.getSnapshot();
  }

  getSnapshot() {
    const base = this.store.getSnapshot();
    return this.mockState ? { ...base, ...this.mockState, mock: true } : base;
  }

  armPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const delay = this.windowVisible
      ? this.config.visiblePollMs
      : this.config.hiddenPollMs;
    this.pollTimer = setTimeout(() => {
      this.refresh('poll', true);
      this.armPolling();
    }, delay);
  }

  shouldRefreshUsage() {
    const interval = this.windowVisible
      ? Number(this.config.visibleUsagePollMs || 0)
      : Number(this.config.hiddenUsagePollMs || 0);
    if (interval <= 0) return true;
    return Date.now() - this.lastUsageRefreshAt >= interval;
  }

  clearWatchers() {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.watchers = [];
  }

  invalidateSessionFilesCache() {
    this.sessionFilesCache = null;
  }

  invalidateSessionIndexCache() {
    this.sessionIndexCache = null;
  }

  getSessionFiles() {
    const rootDir = this.currentPaths?.sessionsRoot;
    if (!rootDir) return [];
    const cacheMs = Math.max(0, Number(this.config.sessionListCacheMs || 0));
    const now = Date.now();
    if (
      this.sessionFilesCache &&
      this.sessionFilesCache.rootDir === rootDir &&
      (cacheMs === 0 || now - this.sessionFilesCache.loadedAt < cacheMs)
    ) {
      return this.sessionFilesCache.files;
    }

    const files = walkJsonlFiles(rootDir);
    this.sessionFilesCache = {
      rootDir,
      files,
      loadedAt: now,
    };
    return files;
  }

  getSessionIndexEntries() {
    const indexPath = this.currentPaths?.sessionIndexPath;
    if (!indexPath || !fs.existsSync(indexPath)) return [];

    let stat = null;
    try {
      stat = fs.statSync(indexPath);
    } catch {
      return [];
    }

    if (
      this.sessionIndexCache &&
      this.sessionIndexCache.path === indexPath &&
      this.sessionIndexCache.mtimeMs === stat.mtimeMs &&
      this.sessionIndexCache.size === stat.size
    ) {
      return this.sessionIndexCache.entries;
    }

    const entries = readSessionIndex(indexPath);
    this.sessionIndexCache = {
      path: indexPath,
      mtimeMs: stat.mtimeMs || 0,
      size: stat.size || 0,
      entries,
    };
    return entries;
  }

  registerWatcher(filePath, refreshReason) {
    if (!this.config.watcherEnabled || !filePath || !fs.existsSync(filePath)) {
      return;
    }
    try {
      const watcher = fs.watch(filePath, () => {
        if (refreshReason !== 'session-change') {
          this.invalidateSessionFilesCache();
        }
        if (refreshReason === 'index-change') {
          this.invalidateSessionIndexCache();
        }
        this.refresh(refreshReason, refreshReason !== 'session-change');
      });
      this.watchers.push(watcher);
    } catch {}
  }

  refresh(reason, includeUsage) {
    this.currentPaths = resolveCodexPaths(this.config);
    this.store.setPaths(this.currentPaths);
    if (this.sessionFilesCache && this.sessionFilesCache.rootDir !== this.currentPaths.sessionsRoot) {
      this.invalidateSessionFilesCache();
    }
    if (
      this.sessionIndexCache &&
      this.sessionIndexCache.path !== this.currentPaths.sessionIndexPath
    ) {
      this.invalidateSessionIndexCache();
    }

    if (!this.currentPaths.exists.sessionsRoot) {
      this.store.setSourceError('未找到 Codex sessions 目录');
      this.store.refresh();
      return;
    }

    const sessionFiles = this.getSessionFiles();
    const sessionIndexEntries = this.getSessionIndexEntries();
    const nextSession = resolveActiveSession(this.currentPaths, {
      sessionFiles,
      sessionIndexEntries,
    });
    const runtimeCache = this.runtimeCacheSnapshot || {};
    const previousSessionPath = this.currentSession?.filePath || null;
    const hasSessionChanged =
      nextSession?.filePath && nextSession.filePath !== previousSessionPath;

    if (hasSessionChanged) {
      this.currentSession = nextSession;
      this.currentOffset =
        runtimeCache?.currentSession?.filePath === nextSession.filePath
          ? Number(runtimeCache.offset || 0)
          : 0;
      this.store.setCurrentSession(nextSession);
      this.clearWatchers();
      this.registerWatcher(this.currentPaths.sessionIndexPath, 'index-change');
      this.registerWatcher(this.currentPaths.globalStatePath, 'global-change');
      this.registerWatcher(nextSession.filePath, 'session-change');
    } else if (!this.currentSession && nextSession) {
      this.currentSession = nextSession;
      this.store.setCurrentSession(nextSession);
    }

    if (this.currentSession?.filePath) {
      const result = this.reader.readNewEvents(
        this.currentSession.filePath,
        this.currentOffset,
      );
      this.currentOffset = result.nextOffset;
      this.store.applyEvents(result.events);
    } else {
      this.store.setSourceError('未解析到活跃会话');
    }

    if (includeUsage && this.shouldRefreshUsage()) {
      const usageSnapshot = collectUsageSnapshot(
        this.currentPaths,
        sessionFiles,
        Date.now(),
        {
          fileCache: this.usageFileCache,
          maxReadBytes: this.config.usageReadTailBytes,
          sessionLimit: this.config.usageSessionLimit,
        },
      );
      this.lastUsageRefreshAt = Date.now();
      this.cache.setUsageCache(usageSnapshot, this.config.usageCacheFlushMs);
      this.store.setUsageSnapshot(usageSnapshot);
    }

    if (this.config.debugLogEnabled) {
      this.cache.appendDebug({
        reason,
        currentSession: this.currentSession?.filePath || null,
        offset: this.currentOffset,
        includeUsage,
      });
    }
  }
}

module.exports = {
  CodexMonitor,
};
