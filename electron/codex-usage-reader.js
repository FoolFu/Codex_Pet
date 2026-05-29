const fs = require('fs');

const WINDOW_KEYS = {
  SHORT: '5h',
  LONG: '7d',
};

function toWindowKey(rateLimit) {
  const minutes = Number(rateLimit?.window_minutes || 0);
  if (!minutes) return null;
  if (minutes === 10080) return WINDOW_KEYS.LONG;
  if (minutes === 300) return WINDOW_KEYS.SHORT;
  if (minutes >= 240 && minutes <= 360) return WINDOW_KEYS.SHORT;
  return null;
}

function createWindowSnapshot(rateLimit, observedAt) {
  if (!rateLimit) {
    return {
      available: false,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      windowMinutes: null,
      lastObservedAt: observedAt || null,
      statusText: '暂不可得',
    };
  }

  const usedPercent = Number(rateLimit.used_percent);
  const remainingPercent = Number.isFinite(usedPercent)
    ? Math.max(0, 100 - usedPercent)
    : null;
  const resetAt = rateLimit.resets_at
    ? new Date(Number(rateLimit.resets_at) * 1000).toISOString()
    : null;

  return {
    available: Number.isFinite(usedPercent) || Boolean(resetAt),
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    remainingPercent,
    resetAt,
    windowMinutes: Number(rateLimit.window_minutes || 0) || null,
    lastObservedAt: observedAt || null,
    statusText: Number.isFinite(remainingPercent)
      ? `剩余 ${remainingPercent}%`
      : '暂不可得',
  };
}

function readTailText(filePath, maxReadBytes) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size || 0;
    const readBytes = Math.min(
      Math.max(1, Number(maxReadBytes || fileSize)),
      fileSize,
    );
    const offset = Math.max(0, fileSize - readBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(readBytes);
    try {
      fs.readSync(fd, buffer, 0, readBytes, offset);
    } finally {
      fs.closeSync(fd);
    }

    let content = buffer.toString('utf8');
    if (offset > 0) {
      const firstLineBreak = content.search(/\r?\n/);
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : '';
    }
    return content;
  } catch {
    return '';
  }
}

function readTokenEvents(filePath, maxReadBytes) {
  try {
    return readTailText(filePath, maxReadBytes)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(
        row =>
          row &&
          row.type === 'event_msg' &&
          row.payload &&
          row.payload.type === 'token_count',
      );
  } catch {
    return [];
  }
}

function collectUsageSnapshot(paths, sessionFiles, nowMs, options = {}) {
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const maxReadBytes = Math.max(1024, Number(options.maxReadBytes || 128 * 1024));
  const fileCache = options.fileCache instanceof Map ? options.fileCache : null;
  const sessionLimit = Math.max(0, Number(options.sessionLimit || 0));
  const windows = {
    [WINDOW_KEYS.SHORT]: createWindowSnapshot(null, null),
    [WINDOW_KEYS.LONG]: createWindowSnapshot(null, null),
  };
  let latestObservedAt = null;
  const seenFiles = fileCache ? new Set() : null;
  const candidates = [];

  for (const filePath of sessionFiles) {
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (nowMs - stat.mtimeMs > maxAgeMs) {
      continue;
    }

    candidates.push({
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const filesToProcess =
    sessionLimit > 0 ? candidates.slice(0, sessionLimit) : candidates;

  for (const candidate of filesToProcess) {
    const { filePath } = candidate;
    let tokenEvents = null;
    const cacheEntry = fileCache ? fileCache.get(filePath) : null;
    if (
      cacheEntry &&
      cacheEntry.mtimeMs === candidate.mtimeMs &&
      cacheEntry.size === candidate.size
    ) {
      tokenEvents = cacheEntry.tokenEvents;
    } else {
      tokenEvents = readTokenEvents(filePath, maxReadBytes);
      if (fileCache) {
        fileCache.set(filePath, {
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          tokenEvents,
        });
      }
    }
    if (seenFiles) {
      seenFiles.add(filePath);
    }

    for (const event of tokenEvents) {
      const observedAt = event.timestamp || new Date(candidate.mtimeMs).toISOString();
      const rateLimits = event.payload?.rate_limits || {};
      for (const rateLimit of [rateLimits.primary, rateLimits.secondary]) {
        const key = toWindowKey(rateLimit);
        if (!key) continue;
        const previousObservedAt = windows[key].lastObservedAt
          ? new Date(windows[key].lastObservedAt).getTime()
          : 0;
        const currentObservedAt = observedAt ? new Date(observedAt).getTime() : 0;

        if (currentObservedAt >= previousObservedAt) {
          windows[key] = createWindowSnapshot(rateLimit, observedAt);
        }
      }

      if (!latestObservedAt || new Date(observedAt).getTime() > new Date(latestObservedAt).getTime()) {
        latestObservedAt = observedAt;
      }
    }
  }

  if (fileCache && seenFiles) {
    for (const filePath of Array.from(fileCache.keys())) {
      if (!seenFiles.has(filePath)) {
        fileCache.delete(filePath);
      }
    }
  }

  return {
    paths: {
      codexHome: paths.codexHome,
      sessionsRoot: paths.sessionsRoot,
      sessionIndexPath: paths.sessionIndexPath,
      globalStatePath: paths.globalStatePath,
    },
    windows,
    lastObservedAt: latestObservedAt,
  };
}

module.exports = {
  WINDOW_KEYS,
  collectUsageSnapshot,
};
