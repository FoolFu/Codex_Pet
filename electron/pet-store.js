const { EventEmitter } = require('events');
const { PetStateMachine } = require('./pet-state-machine');

class PetStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.machine = new PetStateMachine();
    this.currentSession = null;
    this.usage = null;
    this.paths = null;
    this.sourceError = null;
    this.snapshot = this.buildSnapshot();
  }

  setCurrentSession(session) {
    this.currentSession = session || null;
    this.refresh();
  }

  applyEvents(events) {
    if (Array.isArray(events) && events.length) {
      this.machine.applyEvents(events);
    }
    this.refresh();
  }

  setUsageSnapshot(usage) {
    this.usage = usage || null;
    this.refresh();
  }

  setPaths(paths) {
    this.paths = paths || null;
    this.refresh();
  }

  setSourceError(errorMessage) {
    this.sourceError = errorMessage || null;
    this.refresh();
  }

  loadCachedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.snapshot = { ...this.snapshot, ...snapshot };
    this.emit('update', this.snapshot);
  }

  refresh() {
    this.snapshot = this.buildSnapshot();
    this.emit('update', this.snapshot);
  }

  getSnapshot() {
    return this.snapshot;
  }

  buildSnapshot() {
    const runtime = this.machine.getSnapshot({
      staleAfterMs: this.config.staleAfterMs,
    });
    const staleUsage =
      this.usage?.lastObservedAt &&
      Date.now() - new Date(this.usage.lastObservedAt).getTime() > this.config.staleAfterMs;

    return {
      ...runtime,
      session: this.currentSession
        ? {
            id: this.currentSession.sessionId,
            filePath: this.currentSession.filePath,
            threadName: this.currentSession.threadName,
            updatedAtMs: this.currentSession.updatedAtMs,
          }
        : null,
      usage: this.usage,
      paths: this.paths,
      sourceError: this.sourceError,
      offline: runtime.isStale,
      staleUsage: Boolean(staleUsage),
      updatedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  PetStore,
};
