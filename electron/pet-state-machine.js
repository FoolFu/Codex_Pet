function formatStateLabel(snapshot) {
  const state = snapshot.workflowState;
  const outcome = snapshot.outcome;
  if (state === 'done_or_error') {
    return outcome === 'error' ? '出错了' : '完成啦';
  }

  const labels = {
    idle: '待命中',
    thinking: '思考中',
    reading: '读代码',
    editing: '改代码',
    running: '跑命令',
    waiting_user: '等你回复',
  };
  return labels[state] || '待命中';
}

function deriveEmotion(snapshot) {
  const state = snapshot.workflowState;
  if (state === 'done_or_error') {
    return snapshot.outcome === 'error' ? 'frustrated' : 'happy';
  }

  const emotions = {
    idle: 'calm',
    thinking: 'focused',
    reading: 'curious',
    editing: 'diligent',
    running: 'tense',
    waiting_user: 'expectant',
  };
  return emotions[state] || 'calm';
}

class PetStateMachine {
  constructor() {
    this.context = {
      currentTaskActive: false,
      lastEventAt: 0,
      lastUserMessageAt: 0,
      lastAgentMessageAt: 0,
      lastTaskStartedAt: 0,
      lastTaskCompleteAt: 0,
      lastToolState: null,
      lastToolName: null,
      lastAgentPhase: null,
      lastMessage: '',
      outcome: null,
    };
  }

  applyEvents(events) {
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  applyEvent(event) {
    const timestampMs = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
    this.context.lastEventAt = Math.max(this.context.lastEventAt, timestampMs);

    switch (event.kind) {
      case 'task_started':
        this.context.currentTaskActive = true;
        this.context.lastTaskStartedAt = timestampMs;
        this.context.lastToolState = 'thinking';
        this.context.outcome = null;
        break;
      case 'task_complete':
        this.context.currentTaskActive = false;
        this.context.lastTaskCompleteAt = timestampMs;
        this.context.outcome = 'done';
        break;
      case 'user_message':
        this.context.lastUserMessageAt = timestampMs;
        this.context.lastMessage = event.message || '';
        if (!this.context.currentTaskActive) {
          this.context.lastToolState = 'thinking';
        }
        break;
      case 'agent_message':
        this.context.lastAgentMessageAt = timestampMs;
        this.context.lastMessage = event.message || '';
        this.context.lastAgentPhase = event.phase || null;
        break;
      case 'function_call':
        this.context.currentTaskActive = true;
        this.context.lastToolName = event.name || null;
        this.context.lastToolState = event.toolState || this.classifyToolName(event.name);
        break;
      case 'function_call_output':
        if (!this.context.lastToolState) {
          this.context.lastToolState = 'running';
        }
        break;
      default:
        break;
    }
  }

  classifyToolName(name) {
    const lowered = String(name || '').toLowerCase();
    if (
      lowered.includes('read') ||
      lowered.includes('grep') ||
      lowered.includes('search') ||
      lowered.includes('glob') ||
      lowered.includes('ls')
    ) {
      return 'reading';
    }
    if (
      lowered.includes('patch') ||
      lowered.includes('delete') ||
      lowered.includes('edit')
    ) {
      return 'editing';
    }
    return 'running';
  }

  getSnapshot(options = {}) {
    const now = options.now || Date.now();
    const staleAfterMs = Number(options.staleAfterMs || 120000);
    const ageMs = this.context.lastEventAt ? now - this.context.lastEventAt : Infinity;
    const isStale = !this.context.lastEventAt || ageMs > staleAfterMs;
    let workflowState = 'idle';
    let outcome = null;

    if (isStale) {
      workflowState = 'idle';
    } else if (this.context.currentTaskActive) {
      workflowState = this.context.lastToolState || 'thinking';
    } else if (
      this.context.lastTaskCompleteAt &&
      now - this.context.lastTaskCompleteAt < 90000
    ) {
      workflowState = 'done_or_error';
      outcome = this.context.outcome || 'done';
    } else if (
      this.context.lastAgentMessageAt &&
      this.context.lastAgentMessageAt >= this.context.lastUserMessageAt
    ) {
      workflowState = 'waiting_user';
    }

    const progressState =
      workflowState === 'idle'
        ? 'idle'
        : workflowState === 'waiting_user'
          ? 'waiting_user'
          : workflowState === 'done_or_error'
            ? outcome === 'error'
              ? 'error'
              : 'completed'
            : 'active';

    const snapshot = {
      workflowState,
      outcome,
      progressState,
      emotion: 'calm',
      stateLabel: '',
      ageMs,
      isStale,
      lastToolName: this.context.lastToolName,
      lastMessage: this.context.lastMessage,
      lastEventAt: this.context.lastEventAt
        ? new Date(this.context.lastEventAt).toISOString()
        : null,
      lastTaskCompleteAt: this.context.lastTaskCompleteAt
        ? new Date(this.context.lastTaskCompleteAt).toISOString()
        : null,
    };

    snapshot.emotion = deriveEmotion(snapshot);
    snapshot.stateLabel = formatStateLabel(snapshot);
    return snapshot;
  }
}

module.exports = {
  PetStateMachine,
};
