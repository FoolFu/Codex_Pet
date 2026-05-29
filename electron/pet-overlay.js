const fs = require('fs');
const path = require('path');
const { buildBubbleText } = require('./pet-copy');
const { resolveActionPresentation } = require('./pet-actions');

function formatTime(isoText) {
  if (!isoText) return '暂不可得';
  try {
    return new Date(isoText).toLocaleString();
  } catch {
    return '暂不可得';
  }
}

function formatEmotion(emotion) {
  const labels = {
    calm: '平静',
    focused: '专注',
    curious: '好奇',
    diligent: '认真',
    tense: '紧张',
    expectant: '期待',
    happy: '开心',
    frustrated: '沮丧',
  };
  return labels[emotion] || '平静';
}

function formatPercentValue(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '暂不可得';
}

function getQuotaWindow(snapshot, key) {
  return snapshot?.usage?.windows?.[key] || null;
}

function cloneRect(rect) {
  if (!rect) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function simplifyRect(rect) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function areRectsAligned(baseRect, liveRect, threshold = 2) {
  if (!baseRect || !liveRect) return false;
  const baseCenterX = baseRect.left + baseRect.width / 2;
  const liveCenterX = liveRect.left + liveRect.width / 2;
  return (
    Math.abs(baseRect.bottom - liveRect.bottom) <= threshold &&
    Math.abs(baseCenterX - liveCenterX) <= threshold &&
    Math.abs(baseRect.left - liveRect.left) <= threshold
  );
}

function buildQuotaCardHtml(snapshot) {
  const windows = [
    { key: '5h', label: '5h 额度' },
    { key: '7d', label: '7d 额度' },
  ];

  return windows
    .map(({ key, label }) => {
      const quota = getQuotaWindow(snapshot, key);
      const remainingPercent = quota?.remainingPercent;
      const width = Number.isFinite(remainingPercent)
        ? Math.max(0, Math.min(100, remainingPercent))
        : 0;

      return `
        <div class="qqpet-monitor__quota-item">
          <div class="qqpet-monitor__quota-head">
            <span>${label}</span>
            <span>${formatPercentValue(remainingPercent)}</span>
          </div>
          <div class="qqpet-monitor__quota-track">
            <div class="qqpet-monitor__quota-fill" style="width: ${width}%"></div>
          </div>
          <div class="qqpet-monitor__quota-reset">重置：${formatTime(quota?.resetAt)}</div>
        </div>
      `;
    })
    .join('');
}

class PetOverlayController {
  constructor(options = {}) {
    this.debugEnabled = Boolean(options.debugEnabled);
    this.snapshot = null;
    this.root = null;
    this.status = null;
    this.bubble = null;
    this.panel = null;
    this.panelToggle = null;
    this.panelBody = null;
    this.panelGrid = null;
    this.hint = null;
    this.currentAnimatedTarget = null;
    this.panelCollapsed = false;
    this.hasActivated = false;
    this.lockedAnchorRect = null;
    this.liveAnchorStableFrames = 0;
    this.loggedFirstLockedLayout = false;
  }

  debugLog(message, detail) {
    if (!this.debugEnabled) return;
    if (typeof detail === 'undefined') {
      console.debug(`[qqpet-overlay] ${message}`);
      return;
    }
    console.debug(`[qqpet-overlay] ${message}`, detail);
  }

  mount() {
    if (this.root) return;
    this.injectStyles();
    this.createDom();
    window.addEventListener('resize', () => this.scheduleLayout());
  }

  dispose() {
    return;
  }

  injectStyles() {
    if (document.getElementById('qqpet-monitor-style')) return;
    const style = document.createElement('style');
    style.id = 'qqpet-monitor-style';
    style.textContent = fs.readFileSync(
      path.join(__dirname, 'pet-overlay.css'),
      'utf8',
    );
    document.head.appendChild(style);
  }

  createDom() {
    this.root = document.createElement('div');
    this.root.className = 'qqpet-monitor is-idle is-hidden';

    const status = document.createElement('div');
    status.className = 'qqpet-monitor__status';

    const bubble = document.createElement('div');
    bubble.className = 'qqpet-monitor__bubble';

    const panel = document.createElement('div');
    panel.className = 'qqpet-monitor__panel';

    const titleRow = document.createElement('div');
    titleRow.className = 'qqpet-monitor__title-row';

    const title = document.createElement('div');
    title.className = 'qqpet-monitor__title';
    title.textContent = 'Codex 额度';

    const toggle = document.createElement('button');
    toggle.className = 'qqpet-monitor__toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '折叠或展开 Codex 额度');
    toggle.addEventListener('click', () => {
      this.panelCollapsed = !this.panelCollapsed;
      this.syncPanelCollapsed();
      this.scheduleLayout();
    });

    titleRow.appendChild(title);
    titleRow.appendChild(toggle);

    const panelBody = document.createElement('div');
    panelBody.className = 'qqpet-monitor__panel-body';

    const grid = document.createElement('div');
    grid.className = 'qqpet-monitor__quota-list';

    const hint = document.createElement('div');
    hint.className = 'qqpet-monitor__hint';

    panelBody.appendChild(grid);
    panelBody.appendChild(hint);
    panel.appendChild(titleRow);
    panel.appendChild(panelBody);

    this.root.appendChild(status);
    this.root.appendChild(bubble);
    this.root.appendChild(panel);
    document.body.appendChild(this.root);

    this.status = status;
    this.bubble = bubble;
    this.panel = panel;
    this.panelToggle = toggle;
    this.panelBody = panelBody;
    this.panelGrid = grid;
    this.hint = hint;
    this.syncPanelCollapsed();
  }

  setOverlayVisible(visible) {
    if (!this.root) return;
    this.root.classList.toggle('is-hidden', !visible);
  }

  activate(snapshot, anchorRect) {
    if (!this.root) this.mount();
    this.hasActivated = true;
    this.lockedAnchorRect = cloneRect(anchorRect);
    this.liveAnchorStableFrames = 0;
    this.loggedFirstLockedLayout = false;
    this.setOverlayVisible(false);
    this.debugLog('overlay activate with locked anchor', simplifyRect(anchorRect));
    this.renderSnapshot(snapshot || {});
    this.scheduleLayout();
    this.setOverlayVisible(true);
  }

  syncPanelCollapsed() {
    if (!this.panel || !this.panelToggle || !this.panelBody) return;
    this.panel.classList.toggle('is-collapsed', this.panelCollapsed);
    this.panelToggle.textContent = this.panelCollapsed ? '▸' : '▾';
    this.panelToggle.setAttribute('aria-expanded', this.panelCollapsed ? 'false' : 'true');
    this.panelBody.hidden = this.panelCollapsed;
  }

  getTargetScope() {
    return document.querySelector('#root > div > [data-qqpet-widget-target="1"]');
  }

  findAnchorElement() {
    const scope = this.getTargetScope();
    if (!scope) return null;
    return (
      scope.querySelector('ruffle-player') ||
      scope.querySelector('canvas') ||
      scope.querySelector('#container') ||
      scope
    );
  }

  findAnchorRect() {
    const target = this.findAnchorElement();
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }
    const scope = this.getTargetScope();
    return scope ? scope.getBoundingClientRect() : null;
  }

  getAnimatedTarget() {
    const scope = this.getTargetScope();
    const anchor = this.findAnchorElement();
    return scope || anchor || null;
  }

  syncTargetPresentation(presentationClass) {
    const target = this.getAnimatedTarget();
    if (this.currentAnimatedTarget && this.currentAnimatedTarget !== target) {
      delete this.currentAnimatedTarget.dataset.qqpetPresentation;
    }
    if (!target) {
      this.currentAnimatedTarget = null;
      return;
    }
    target.dataset.qqpetPresentation = presentationClass;
    this.currentAnimatedTarget = target;
  }

  scheduleLayout() {
    if (!this.root) return;
    if (!this.hasActivated) {
      this.setOverlayVisible(false);
      return;
    }
    const panel = this.panel;
    const liveAnchor = this.findAnchorRect();
    const anchor = this.lockedAnchorRect || liveAnchor;
    if (!anchor) {
      this.setOverlayVisible(false);
      this.status.style.left = '24px';
      this.status.style.top = '24px';
      this.bubble.style.left = '24px';
      this.bubble.style.top = '160px';
      panel.style.left = '24px';
      panel.style.top = '270px';
      return;
    }

    if (this.lockedAnchorRect) {
      if (!this.loggedFirstLockedLayout) {
        this.loggedFirstLockedLayout = true;
        this.debugLog('overlay first layout with locked anchor', {
          locked: simplifyRect(this.lockedAnchorRect),
          live: simplifyRect(liveAnchor),
        });
      }
      if (liveAnchor && areRectsAligned(this.lockedAnchorRect, liveAnchor)) {
        this.liveAnchorStableFrames += 1;
      } else {
        this.liveAnchorStableFrames = 0;
      }
    } else {
      this.liveAnchorStableFrames = 0;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const outerGap = 16;
    const innerGap = 24;
    const statusRect = this.status.getBoundingClientRect();
    const bubbleRect = this.bubble.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

    const statusLeft = clamp(
      Math.round(anchor.left + anchor.width / 2 - statusRect.width / 2),
      outerGap,
      viewportWidth - statusRect.width - outerGap,
    );
    const statusTop = Math.max(8, Math.round(anchor.top - statusRect.height - 0));

    const bubbleLeft = clamp(
      Math.round(anchor.left + anchor.width / 2 - bubbleRect.width / 2),
      outerGap,
      viewportWidth - bubbleRect.width - outerGap,
    );
    const bubbleTop = clamp(
      Math.round(anchor.bottom + innerGap),
      outerGap,
      viewportHeight - bubbleRect.height - panelRect.height - innerGap - outerGap,
    );

    const panelLeft = clamp(
      Math.round(anchor.left + anchor.width / 2 - panelRect.width / 2),
      outerGap,
      viewportWidth - panelRect.width - outerGap,
    );
    const panelTop = clamp(
      Math.round(bubbleTop + bubbleRect.height + 16),
      outerGap,
      viewportHeight - panelRect.height - outerGap,
    );

    this.status.style.left = `${statusLeft}px`;
    this.status.style.top = `${statusTop}px`;
    this.bubble.style.left = `${bubbleLeft}px`;
    this.bubble.style.top = `${bubbleTop}px`;
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;
    this.setOverlayVisible(true);
    if (this.lockedAnchorRect && this.liveAnchorStableFrames >= 3) {
      this.debugLog('live anchor stable enough, lock released', {
        locked: simplifyRect(this.lockedAnchorRect),
        live: simplifyRect(liveAnchor),
      });
      this.lockedAnchorRect = null;
      this.liveAnchorStableFrames = 0;
    }
  }

  renderSnapshot(snapshot) {
    if (!this.root) return;
    this.snapshot = snapshot || null;
    const presentation = resolveActionPresentation(snapshot || {});
    const hiddenClass = this.root.classList.contains('is-hidden') ? ' is-hidden' : '';
    this.root.className = `qqpet-monitor ${presentation.presentationClass}${hiddenClass}`;
    this.status.textContent = presentation.statusLabel;
    this.status.title = `${presentation.statusLabel} · ${presentation.actionSemantic}`;
    this.bubble.textContent = buildBubbleText(snapshot || {});
    this.syncTargetPresentation(presentation.presentationClass);
    this.panelGrid.innerHTML = buildQuotaCardHtml(snapshot);

    this.hint.textContent = snapshot?.offline
      ? '当前使用缓存或静默待命，数据可能已过期。'
      : snapshot?.sourceError
        ? snapshot.sourceError
        : `更新：${formatTime(snapshot?.updatedAt)}`;
  }

  update(snapshot) {
    this.snapshot = snapshot || null;
    if (!this.hasActivated) {
      return;
    }
    if (!this.root) this.mount();
    this.renderSnapshot(snapshot || {});
    this.scheduleLayout();
  }
}

module.exports = {
  PetOverlayController,
};
