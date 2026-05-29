const fs = require('fs');
const path = require('path');

const SESSION_FILE_RE = /(rollout-[^\\\/]+-([0-9a-f-]{36}))\.jsonl$/i;

function walkJsonlFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function parseSessionId(filePath) {
  const match = filePath.match(SESSION_FILE_RE);
  return match ? match[2] : null;
}

function readSessionIndex(sessionIndexPath) {
  if (!sessionIndexPath || !fs.existsSync(sessionIndexPath)) return [];
  try {
    return fs
      .readFileSync(sessionIndexPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(entry => entry && entry.id);
  } catch {
    return [];
  }
}

function resolveActiveSession(paths, options = {}) {
  const sessionFiles = Array.isArray(options.sessionFiles)
    ? options.sessionFiles
    : walkJsonlFiles(paths.sessionsRoot);
  const files = sessionFiles.filter(
    filePath => path.basename(filePath) !== 'session_index.jsonl',
  );
  const indexEntries = Array.isArray(options.sessionIndexEntries)
    ? options.sessionIndexEntries
    : readSessionIndex(paths.sessionIndexPath);
  const indexById = new Map(indexEntries.map(entry => [entry.id, entry]));
  let bestCandidate = null;

  for (const filePath of files) {
    const sessionId = parseSessionId(filePath);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const indexEntry = sessionId ? indexById.get(sessionId) : null;
    const indexedUpdatedAt = indexEntry?.updated_at
      ? new Date(indexEntry.updated_at).getTime()
      : 0;
    const effectiveUpdatedAt = Math.max(stat.mtimeMs || 0, indexedUpdatedAt || 0);

    if (bestCandidate && effectiveUpdatedAt <= bestCandidate.updatedAtMs) {
      continue;
    }

    bestCandidate = {
      sessionId,
      filePath,
      threadName: indexEntry?.thread_name || null,
      updatedAtMs: effectiveUpdatedAt,
      mtimeMs: stat.mtimeMs || 0,
      size: stat.size || 0,
    };
  }

  return bestCandidate;
}

module.exports = {
  parseSessionId,
  readSessionIndex,
  resolveActiveSession,
  walkJsonlFiles,
};
