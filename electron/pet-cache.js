const fs = require('fs');
const path = require('path');

class PetCache {
  constructor(app) {
    this.baseDir = app.getPath('userData');
    this.runtimePath = path.join(this.baseDir, 'pet-runtime-cache.json');
    this.usagePath = path.join(this.baseDir, 'pet-usage-cache.json');
    this.debugLogPath = path.join(this.baseDir, 'pet-debug-log.jsonl');
    this.pendingWrites = new Map();
    this.lastWrittenContent = new Map();
    this.memoryCache = new Map();
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  readJson(filePath, fallbackValue) {
    try {
      if (!fs.existsSync(filePath)) return fallbackValue;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallbackValue;
    }
  }

  writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  }

  scheduleJsonWrite(filePath, value, delayMs = 0) {
    let serialized = null;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch {
      return;
    }

    const pending = this.pendingWrites.get(filePath);
    if (pending?.serialized === serialized) {
      return;
    }
    if (this.lastWrittenContent.get(filePath) === serialized) {
      return;
    }
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }

    const flush = () => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, serialized, 'utf8');
        fs.renameSync(tempPath, filePath);
        this.lastWrittenContent.set(filePath, serialized);
      } catch {}
      this.pendingWrites.delete(filePath);
    };

    if (delayMs > 0) {
      const timer = setTimeout(flush, delayMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pendingWrites.set(filePath, { timer, serialized });
      return;
    }

    flush();
  }

  getRuntimeCache() {
    if (!this.memoryCache.has(this.runtimePath)) {
      this.memoryCache.set(this.runtimePath, this.readJson(this.runtimePath, {}));
    }
    return this.memoryCache.get(this.runtimePath);
  }

  setRuntimeCache(value, delayMs = 0) {
    this.memoryCache.set(this.runtimePath, value);
    this.scheduleJsonWrite(this.runtimePath, value, delayMs);
  }

  getUsageCache() {
    if (!this.memoryCache.has(this.usagePath)) {
      this.memoryCache.set(this.usagePath, this.readJson(this.usagePath, {}));
    }
    return this.memoryCache.get(this.usagePath);
  }

  setUsageCache(value, delayMs = 0) {
    this.memoryCache.set(this.usagePath, value);
    this.scheduleJsonWrite(this.usagePath, value, delayMs);
  }

  appendDebug(entry) {
    try {
      fs.appendFileSync(
        this.debugLogPath,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
        'utf8',
      );
    } catch {}
  }
}

module.exports = {
  PetCache,
};
