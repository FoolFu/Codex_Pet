const fs = require('fs');
const path = require('path');

function normalizeMaybe(filePath) {
  if (!filePath) return null;
  try {
    return path.resolve(filePath);
  } catch {
    return null;
  }
}

function resolveCodexPaths(config) {
  const codexHome = normalizeMaybe(config.codexHome);
  const sessionsRoot =
    normalizeMaybe(config.sessionsRoot) ||
    (codexHome ? path.join(codexHome, 'sessions') : null);
  const sessionIndexPath =
    normalizeMaybe(config.sessionIndexPath) ||
    (codexHome ? path.join(codexHome, 'session_index.jsonl') : null);
  const globalStatePath =
    normalizeMaybe(config.globalStatePath) ||
    (codexHome ? path.join(codexHome, '.codex-global-state.json') : null);

  return {
    codexHome,
    sessionsRoot,
    sessionIndexPath,
    globalStatePath,
    exists: {
      codexHome: Boolean(codexHome && fs.existsSync(codexHome)),
      sessionsRoot: Boolean(sessionsRoot && fs.existsSync(sessionsRoot)),
      sessionIndexPath: Boolean(sessionIndexPath && fs.existsSync(sessionIndexPath)),
      globalStatePath: Boolean(globalStatePath && fs.existsSync(globalStatePath)),
    },
  };
}

module.exports = {
  resolveCodexPaths,
};
