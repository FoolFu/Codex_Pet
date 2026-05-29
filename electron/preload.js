const { contextBridge, ipcRenderer } = require('electron');
const widgetConfig = require('./widget-config');
const { PetOverlayController } = require('./pet-overlay');

const isWidgetMode =
  new URLSearchParams(window.location.search).get('widget') === '1';
const isDevMode =
  process.env.QQPET_DEV === '1' ||
  process.argv.includes('--qqpet-dev');
let widgetDragging = false;
let lastPetSnapshot = null;
let overlayBooting = false;
let overlayActivated = false;
const petStateListeners = new Set();
const overlayController = new PetOverlayController({
  debugEnabled: isDevMode,
});

function debugOverlayLog(message, detail) {
  if (!isDevMode) return;
  if (typeof detail === 'undefined') {
    console.debug(`[qqpet-overlay] ${message}`);
    return;
  }
  console.debug(`[qqpet-overlay] ${message}`, detail);
}

function emitPetSnapshot(snapshot) {
  lastPetSnapshot = snapshot;
  if (overlayActivated) {
    debugOverlayLog('render state snapshot after activation');
    overlayController.update(snapshot || {});
  }
  for (const listener of petStateListeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

function installPetStateBridge(options = {}) {
  const skipInitialFetch = Boolean(options.skipInitialFetch);
  ipcRenderer.removeAllListeners('qqpet:state');
  ipcRenderer.on('qqpet:state', (_event, snapshot) => {
    debugOverlayLog('state snapshot received');
    emitPetSnapshot(snapshot);
  });
  if (skipInitialFetch) return;
  ipcRenderer
    .invoke('qqpet:get-state')
    .then(snapshot => {
      if (snapshot) emitPetSnapshot(snapshot);
    })
    .catch(() => {});
}

function installDesktopPetMode() {
  if (!isWidgetMode) return;

  const style = document.createElement('style');
  style.setAttribute('data-qqpet-desktop-mode', '1');
  style.textContent = `
    html, body, #root {
      background: transparent !important;
      overflow: hidden !important;
      margin: 0 !important;
    }

    #root[data-qqpet-widget="1"] > div {
      background: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      overflow: visible !important;
      position: relative !important;
    }

    #root[data-qqpet-widget="1"] > div > :not([data-qqpet-widget-target="1"]) {
      display: none !important;
    }

    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] {
      pointer-events: auto !important;
      background: transparent !important;
      background-image: none !important;
      position: relative !important;
      overflow: visible !important;
      left: auto !important;
      top: auto !important;
      right: auto !important;
      bottom: auto !important;
      margin: 0 !important;
    }

    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] .quickbar,
    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] .button,
    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] .button1,
    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] .bubble,
    #root[data-qqpet-widget="1"] > div > [data-qqpet-widget-target="1"] .message {
      display: none !important;
    }
  `;

  document.head.appendChild(style);
}

function installPetPositioning() {
  if (!isWidgetMode) return;

  const petOffsetLeft = Number(widgetConfig.petOffsetLeft || 0);
  const petOffsetTop = Number(widgetConfig.petOffsetTop || 0);

  const findMainPetElement = () => {
    const scope = document.querySelector('#root > div > [data-qqpet-widget-target="1"]');
    if (!scope) return null;
    return (
      scope.querySelector('ruffle-player') ||
      scope.querySelector('#container') ||
      scope.querySelector('canvas')
    );
  };

  const applyPosition = () => {
    const main = findMainPetElement();
    if (!main) return false;
    main.style.position = 'absolute';
    main.style.left = `${petOffsetLeft}px`;
    main.style.top = `${petOffsetTop}px`;
    main.style.right = 'auto';
    main.style.bottom = 'auto';
    main.style.margin = '0';
    debugOverlayLog('pet positioned', {
      scope: simplifyRect(getWidgetScope()?.getBoundingClientRect()),
      main: simplifyRect(main.getBoundingClientRect()),
    });
    return true;
  };

  if (applyPosition()) return;

  const observer = new MutationObserver(() => {
    if (applyPosition()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function getWidgetScope() {
  return document.querySelector('#root > div > [data-qqpet-widget-target="1"]');
}

function findMainPetElement(scope = getWidgetScope()) {
  if (!scope) return null;
  return (
    scope.querySelector('ruffle-player') ||
    scope.querySelector('#container') ||
    scope.querySelector('canvas')
  );
}

function findPetRenderCanvas(main = findMainPetElement(), scope = getWidgetScope()) {
  if (main?.tagName === 'CANVAS') return main;
  return main?.querySelector?.('canvas') || scope?.querySelector?.('canvas') || null;
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

function waitAnimationFrames(count = 1) {
  return new Promise(resolve => {
    const step = remaining => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(remaining - 1));
    };
    step(Math.max(0, count));
  });
}

function inspectCanvasPaint(canvas) {
  if (!canvas) {
    return { state: 'missing', opaqueSamples: 0, totalSamples: 0 };
  }
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return { state: 'missing', opaqueSamples: 0, totalSamples: 0 };
  }
  const width = Math.max(1, Math.floor(canvas.width || rect.width));
  const height = Math.max(1, Math.floor(canvas.height || rect.height));

  try {
    const context = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
    if (!context) {
      return { state: 'unknown', opaqueSamples: 0, totalSamples: 0 };
    }

    // Skip the canvas edges so a loading frame or border does not count as the penguin.
    const sampleCols = 5;
    const sampleRows = 5;
    let visibleSamples = 0;
    const insetX = Math.max(1, Math.round(width * 0.14));
    const insetY = Math.max(1, Math.round(height * 0.1));
    const usableWidth = Math.max(1, width - insetX * 2);
    const usableHeight = Math.max(1, height - insetY * 2);

    for (let row = 0; row < sampleRows; row += 1) {
      for (let col = 0; col < sampleCols; col += 1) {
        const x = Math.min(
          width - 1,
          Math.max(
            0,
            insetX + Math.round(((col + 0.5) / sampleCols) * usableWidth),
          ),
        );
        const y = Math.min(
          height - 1,
          Math.max(
            0,
            insetY + Math.round(((row + 0.5) / sampleRows) * usableHeight),
          ),
        );
        const pixel = context.getImageData(x, y, 1, 1).data;
        if (pixel[3] > 24) {
          visibleSamples += 1;
        }
      }
    }

    const totalSamples = sampleCols * sampleRows;
    const opaqueRatio = visibleSamples / totalSamples;
    return {
      state: visibleSamples >= 6 && opaqueRatio >= 0.24 ? 'painted' : 'blank',
      opaqueSamples: visibleSamples,
      totalSamples,
    };
  } catch {
    return { state: 'unknown', opaqueSamples: 0, totalSamples: 0 };
  }
}

function waitForPetVisualReady() {
  if (!isWidgetMode) return Promise.resolve();

  const expectedLeft = `${Number(widgetConfig.petOffsetLeft || 0)}px`;
  const expectedTop = `${Number(widgetConfig.petOffsetTop || 0)}px`;
  const timeoutMs = 3000;
  const paintedVisibleDelayMs = 1200;
  const fallbackVisibleDelayMs = 8900;

  return new Promise(resolve => {
    const startedAt = performance.now();
    let rafId = null;
    let lastSignature = '';
    let stableFrames = 0;
    let visibleSince = 0;
    let done = false;
    let timeoutLogged = false;
    let firstVisibleLogged = false;
    let firstPaintLogged = false;
    let paintedSince = 0;

    const finish = anchorRect => {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      resolve(anchorRect ? cloneRect(anchorRect) : null);
    };

    const inspect = () => {
      rafId = null;
      const scope = getWidgetScope();
      const main = findMainPetElement(scope);

      if (!scope || !main) {
        if (!timeoutLogged && performance.now() - startedAt >= timeoutMs) {
          timeoutLogged = true;
          debugOverlayLog('pet ready wait timed out before target became available');
        }
        rafId = requestAnimationFrame(inspect);
        return;
      }

      const rect = scope.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const renderCanvas = findPetRenderCanvas(main, scope);
      const renderCanvasRect = renderCanvas?.getBoundingClientRect?.() || null;
      const style = window.getComputedStyle(main);
      const positionApplied =
        style.position === 'absolute' &&
        style.left === expectedLeft &&
        style.top === expectedTop;
      const hasSize = rect.width > 0 && rect.height > 0 && mainRect.width > 0 && mainRect.height > 0;
      const petVisibleInViewport =
        mainRect.bottom > 0 &&
        mainRect.right > 0 &&
        mainRect.top < window.innerHeight &&
        mainRect.left < window.innerWidth &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0;
      const canvasVisibleInViewport =
        renderCanvasRect &&
        renderCanvasRect.bottom > 0 &&
        renderCanvasRect.right > 0 &&
        renderCanvasRect.top < window.innerHeight &&
        renderCanvasRect.left < window.innerWidth;
      const canvasPaint = inspectCanvasPaint(renderCanvas);
      const canvasPaintState = canvasPaint.state;
      const renderPixelsReady = canvasPaintState === 'painted';
      const renderPixelsUnknown =
        canvasPaintState === 'unknown' || canvasPaintState === 'missing';
      const renderFallbackReady =
        renderPixelsUnknown &&
        ((!renderCanvas && petVisibleInViewport) || canvasVisibleInViewport);
      const signature = [
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
        Math.round(mainRect.left),
        Math.round(mainRect.top),
        Math.round(mainRect.width),
        Math.round(mainRect.height),
        Math.round(renderCanvasRect?.width || 0),
        Math.round(renderCanvasRect?.height || 0),
        canvasPaintState,
        `${canvasPaint.opaqueSamples}/${canvasPaint.totalSamples}`,
        style.left,
        style.top,
      ].join(':');

      if (renderPixelsReady) {
        if (!paintedSince) {
          paintedSince = performance.now();
        }
      } else {
        paintedSince = 0;
      }

      const paintedLongEnough =
        paintedSince > 0 && performance.now() - paintedSince >= paintedVisibleDelayMs;
      const renderReady = paintedLongEnough || renderFallbackReady;

      if (
        positionApplied &&
        hasSize &&
        petVisibleInViewport &&
        renderReady &&
        signature === lastSignature
      ) {
        stableFrames += 1;
      } else if (positionApplied && hasSize && petVisibleInViewport && renderReady) {
        stableFrames = 1;
      } else {
        stableFrames = 0;
      }
      lastSignature = signature;

      if (positionApplied && hasSize && petVisibleInViewport && renderReady) {
        if (!visibleSince) {
          visibleSince = performance.now();
        }
        if (!firstVisibleLogged) {
          firstVisibleLogged = true;
          debugOverlayLog('mainRect first visible', {
            scope: simplifyRect(rect),
            main: simplifyRect(mainRect),
          });
        }
        if (!firstPaintLogged) {
          firstPaintLogged = true;
          debugOverlayLog('render surface ready', {
            paintState: canvasPaintState,
            opaqueSamples: canvasPaint.opaqueSamples,
            totalSamples: canvasPaint.totalSamples,
            canvas: simplifyRect(renderCanvasRect),
          });
        }
      } else {
        visibleSince = 0;
      }

      const visibleLongEnough =
        visibleSince > 0 &&
        performance.now() - visibleSince >=
          (paintedLongEnough ? 0 : fallbackVisibleDelayMs);

      if (stableFrames >= 4 && visibleLongEnough) {
        const stableAnchorRect =
          mainRect.width > 0 && mainRect.height > 0 ? mainRect : rect;
        debugOverlayLog('stable anchor locked', {
          scope: cloneRect(rect),
          main: cloneRect(mainRect),
          canvas: cloneRect(renderCanvasRect),
          anchor: cloneRect(stableAnchorRect),
        });
        finish(stableAnchorRect);
        return;
      }

      if (!timeoutLogged && performance.now() - startedAt >= timeoutMs) {
        timeoutLogged = true;
        debugOverlayLog('pet ready wait exceeded soft timeout, continuing to wait');
      }

      rafId = requestAnimationFrame(inspect);
    };

    rafId = requestAnimationFrame(inspect);
  });
}

async function bootWidgetOverlayWhenPetVisible() {
  if (!isWidgetMode) return;
  if (overlayBooting || overlayActivated) return;
  overlayBooting = true;

  const firstStableAnchorRect = await waitForPetVisualReady();
  if (overlayActivated || !firstStableAnchorRect) {
    overlayBooting = false;
    return;
  }

  debugOverlayLog(
    'overlay activate start',
    simplifyRect(firstStableAnchorRect),
  );

  const snapshot = await ipcRenderer.invoke('qqpet:get-state').catch(() => null);
  if (snapshot) {
    lastPetSnapshot = snapshot;
  }

  await waitAnimationFrames(2);
  overlayController.activate(snapshot || lastPetSnapshot || {}, firstStableAnchorRect);
  overlayActivated = true;
  overlayBooting = false;
  debugOverlayLog('state bridge installed');
  installPetStateBridge({ skipInitialFetch: true });
}

function bootWidgetPetRuntime() {
  installDesktopPetMode();
  installWidgetTargetSelection();
  installPetPositioning();
  installAutoResize();
  installMousePassThrough();
  installSmartDrag();
}

function installWidgetTargetSelection() {
  if (!isWidgetMode) return;

  const root = document.getElementById('root');
  const rootWrap = document.querySelector('#root > div');
  if (!root || !rootWrap) return;

  const compactTarget = () => true;

  const scoreChild = child => {
    if (!child) return -100000;
    if (child.tagName === 'FOOTER') return -100000;
    if (child.querySelector('.footer__start,[class*="footer__"]')) return -100000;

    let score = 0;
    if (child.querySelector('ruffle-player')) score += 400;
    if (child.querySelector('[class*="pet" i],[id*="pet" i]')) score += 300;
    if (child.querySelector('canvas')) score += 120;

    const rect = child.getBoundingClientRect();
    score += Math.min(200, Math.round((rect.width * rect.height) / 20000));

    return score;
  };

  const pickTarget = () => {
    const children = Array.from(rootWrap.children);
    const scored = children
      .map(child => ({ child, score: scoreChild(child) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score <= 0) return null;
    return best.child;
  };

  const applyTarget = target => {
    if (!target) return;
    if (root.getAttribute('data-qqpet-widget') === '1') return;

    Array.from(rootWrap.children).forEach(child => {
      if (child === target) {
        child.setAttribute('data-qqpet-widget-target', '1');
      } else {
        child.removeAttribute('data-qqpet-widget-target');
      }
    });
    root.setAttribute('data-qqpet-widget', '1');
    debugOverlayLog('target selected', {
      targetTag: target.tagName,
      rect: simplifyRect(target.getBoundingClientRect()),
    });
  };

  const tryApply = () => {
    const target = pickTarget();
    if (target) {
      applyTarget(target);
      return true;
    }
    return false;
  };

  if (tryApply()) return;
  const observer = new MutationObserver(() => {
    if (tryApply()) observer.disconnect();
  });
  observer.observe(rootWrap, { childList: true, subtree: true });
}

function installAutoResize() {
  if (!isWidgetMode) return;
  if (widgetConfig.sizeOverride) return;

  const findPetElement = () => {
    const scope = document.querySelector(
      '#root > div > [data-qqpet-widget-target="1"]',
    );
    if (!scope) return null;
    return (
      scope.querySelector('ruffle-player') ||
      scope.querySelector('canvas') ||
      scope.querySelector('#container') ||
      scope
    );
  };

  let lastSent = null;
  let lastMeasured = null;
  let stableFrames = 0;
  let rafId = null;
  let observer = null;
  const startAt = performance.now();
  let sendCount = 0;
  const maxDurationMs = 10000;
  const maxSends = 6;

  const measureAndSend = () => {
    rafId = null;
    if (sendCount >= maxSends) return;
    if (performance.now() - startAt > maxDurationMs) {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', requestMeasure);
      return;
    }
    const el = findPetElement();
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const paddingX = Math.max(0, Number(widgetConfig.sizePaddingX || 0));
    const paddingY = Math.max(0, Number(widgetConfig.sizePaddingY || 0));
    const left = Math.max(0, Math.round(rect.left));
    const top = Math.max(0, Math.round(rect.top));
    const width = Math.round(left + rect.width + paddingX);
    const height = Math.round(top + rect.height + paddingY);
    if (!width || !height) return;

    const current = `${width}x${height}`;
    if (current === lastMeasured) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }
    lastMeasured = current;

    if (stableFrames >= 2 && current !== lastSent) {
      ipcRenderer.send('qqpetwidget:content-size', {
        width,
        height,
      });
      lastSent = current;
      sendCount += 1;
      stableFrames = 0;
    }
  };

  const requestMeasure = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(measureAndSend);
  };

  observer = new MutationObserver(requestMeasure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', requestMeasure);
  requestMeasure();
}

function installMousePassThrough() {
  if (!isWidgetMode) return;

  let currentIgnore = null;
  let rafId = null;
  let lastEvent = null;

  const setIgnore = ignore => {
    if (currentIgnore === ignore) return;
    ipcRenderer.send('qqpetwidget:set-ignore-mouse', { ignore });
    currentIgnore = ignore;
  };

  const getScope = () => {
    return document.querySelector('#root > div > [data-qqpet-widget-target="1"]');
  };

  const getRect = el => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };

  const getInteractiveRects = () => {
    const rects = [];
    const scope = getScope();
    const main =
      scope?.querySelector('ruffle-player') ||
      scope?.querySelector('canvas') ||
      scope?.querySelector('#container');
    const panel = document.querySelector('.qqpet-monitor__panel');

    const mainRect = getRect(main);
    const panelRect = getRect(panel);

    if (mainRect) rects.push(mainRect);
    if (panelRect) rects.push(panelRect);
    return rects;
  };

  const update = () => {
    rafId = null;
    if (!lastEvent) return;
    if (widgetDragging) {
      setIgnore(false);
      return;
    }
    const rects = getInteractiveRects();
    if (!rects.length) return;
    const x = lastEvent.clientX;
    const y = lastEvent.clientY;
    const inside = rects.some(
      rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
    setIgnore(!inside);
  };

  setIgnore(true);

  window.addEventListener(
    'mousemove',
    e => {
      lastEvent = e;
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    },
    { passive: true, capture: true },
  );

  window.addEventListener('mouseleave', () => setIgnore(true));
}

function installSmartDrag() {
  if (!isWidgetMode) return;

  const holdMs = Math.max(0, Number(widgetConfig.dragHoldMs || 0));
  const moveThreshold = Math.max(0, Number(widgetConfig.dragMoveThreshold || 0));

  const pickCanvas = scope => {
    const canvases = Array.from(scope.querySelectorAll('canvas'));
    const ranked = canvases
      .map(canvas => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return { canvas, width, height, area: width * height };
      })
      .filter(item => item.area > 0)
      .sort((a, b) => a.area - b.area);
    return ranked[0]?.canvas || null;
  };

  const findPetElement = () => {
    const scope =
      document.querySelector('#root > div > [data-qqpet-widget-target="1"]') ||
      document.querySelector('#root > div') ||
      document;
    return (
      scope.querySelector('ruffle-player') || pickCanvas(scope)
    );
  };

  const tryAttach = () => {
    const target = findPetElement();
    if (!target) return false;
    if (target.getAttribute('data-qqpet-drag') === '1') return true;
    target.setAttribute('data-qqpet-drag', '1');

    let down = null;
    let dragging = false;
    let dragStartSent = false;
    let rafPending = false;
    let lastMove = null;

    const isPointerInsideTarget = e => {
      const rect = target.getBoundingClientRect();
      return (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
    };

    const sendMove = () => {
      rafPending = false;
      if (!lastMove) return;
      ipcRenderer.send('qqpetwidget:drag-move');
      lastMove = null;
    };

    const endDrag = e => {
      if (!down) return;
      if (dragging) {
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('qqpetwidget:drag-end');
      }
      down = null;
      dragging = false;
      dragStartSent = false;
      widgetDragging = false;
      rafPending = false;
      lastMove = null;
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
    };

    const onPointerMove = e => {
      if (!down) return;
      if (!isPointerInsideTarget(e)) {
        endDrag(e);
        return;
      }
      const dx = e.screenX - down.startScreenX;
      const dy = e.screenY - down.startScreenY;
      const dist = Math.hypot(dx, dy);
      const elapsed = performance.now() - down.startAt;

      if (!dragging) {
        if (elapsed < holdMs) return;
        if (dist < moveThreshold) return;
        dragging = true;
      }

      if (dragging) {
        if (!dragStartSent) {
          widgetDragging = true;
          ipcRenderer.send('qqpetwidget:set-ignore-mouse', { ignore: false });
          ipcRenderer.send('qqpetwidget:drag-start');
          dragStartSent = true;
        }

        e.preventDefault();
        e.stopPropagation();
        lastMove = true;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(sendMove);
        }
      }
    };

    target.addEventListener(
      'pointerdown',
      e => {
        if (e.button !== 0) return;
        down = {
          startAt: performance.now(),
          startScreenX: e.screenX,
          startScreenY: e.screenY,
        };
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', endDrag, true);
        window.addEventListener('pointercancel', endDrag, true);
      },
      true,
    );

    return true;
  };

  if (tryAttach()) return;
  const observer = new MutationObserver(() => {
    if (tryAttach()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      bootWidgetPetRuntime();
      bootWidgetOverlayWhenPetVisible();
    },
    { once: true },
  );
} else {
  bootWidgetPetRuntime();
  bootWidgetOverlayWhenPetVisible();
}

contextBridge.exposeInMainWorld('qqPetWidget', {
  isWidgetMode,
  subscribePetState(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    petStateListeners.add(listener);
    if (lastPetSnapshot) {
      try {
        listener(lastPetSnapshot);
      } catch {}
    }
    return () => {
      petStateListeners.delete(listener);
    };
  },
  getPetSnapshot() {
    return lastPetSnapshot;
  },
  getDebugState() {
    return ipcRenderer.invoke('qqpet:get-debug-state');
  },
  setMockState(patch) {
    return ipcRenderer.invoke('qqpet:set-mock-state', patch || {});
  },
});
