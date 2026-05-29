const fs = require('fs');

function parseMaybeJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function classifyShellCommand(command) {
  const raw = String(command || '').toLowerCase();
  if (!raw) return 'running';

  if (
    raw.includes('get-content') ||
    raw.includes('type ') ||
    raw.includes('cat ') ||
    raw.includes('rg ') ||
    raw.includes('ripgrep') ||
    raw.includes('ls ') ||
    raw.includes('dir ') ||
    raw.includes('get-childitem')
  ) {
    return 'reading';
  }

  if (
    raw.includes('apply_patch') ||
    raw.includes('set-content') ||
    raw.includes('add-content') ||
    raw.includes('move-item') ||
    raw.includes('copy-item') ||
    raw.includes('rename-item')
  ) {
    return 'editing';
  }

  return 'running';
}

function parseStandardEvent(record) {
  if (!record || typeof record !== 'object') return null;
  const timestamp = record.timestamp || new Date().toISOString();
  const payload = record.payload || {};

  if (record.type === 'event_msg') {
    switch (payload.type) {
      case 'task_started':
        return { kind: 'task_started', timestamp, payload };
      case 'task_complete':
        return { kind: 'task_complete', timestamp, payload };
      case 'user_message':
        return { kind: 'user_message', timestamp, message: payload.message || '' };
      case 'agent_message':
        return {
          kind: 'agent_message',
          timestamp,
          message: payload.message || '',
          phase: payload.phase || null,
        };
      case 'token_count':
        return {
          kind: 'token_count',
          timestamp,
          rateLimits: payload.rate_limits || null,
          usage: payload.info || null,
        };
      default:
        return null;
    }
  }

  if (record.type === 'response_item') {
    if (payload.type === 'function_call') {
      const parsedArgs = parseMaybeJson(payload.arguments);
      const command = parsedArgs?.command || null;
      return {
        kind: 'function_call',
        timestamp,
        name: payload.name || null,
        arguments: parsedArgs,
        toolState: payload.name === 'shell_command'
          ? classifyShellCommand(command)
          : null,
      };
    }

    if (payload.type === 'function_call_output') {
      return {
        kind: 'function_call_output',
        timestamp,
        output: payload.output || '',
      };
    }
  }

  return null;
}

class CodexEventReader {
  constructor(options = {}) {
    this.maxInitialReadBytes = Math.max(
      0,
      Number(options.maxInitialReadBytes || 0),
    );
  }

  readNewEvents(filePath, previousOffset) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { events: [], nextOffset: 0, fileSize: 0 };
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size || 0;
    let offset = Math.max(0, Number(previousOffset || 0));

    if (offset > fileSize) {
      offset = 0;
    }

    if (offset === fileSize) {
      return { events: [], nextOffset: offset, fileSize };
    }

    // On cold start, only tail large session logs because the state machine only
    // needs recent activity to recover the current pet state.
    if (
      offset === 0 &&
      this.maxInitialReadBytes > 0 &&
      fileSize > this.maxInitialReadBytes
    ) {
      offset = Math.max(0, fileSize - this.maxInitialReadBytes);
    }

    const fd = fs.openSync(filePath, 'r');
    const length = fileSize - offset;
    const buffer = Buffer.alloc(length);

    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }

    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/);
    if (offset > 0 && lines.length > 0) {
      lines.shift();
    }
    const events = lines
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return parseStandardEvent(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      events,
      nextOffset: fileSize,
      fileSize,
    };
  }
}

module.exports = {
  CodexEventReader,
  classifyShellCommand,
  parseStandardEvent,
};
