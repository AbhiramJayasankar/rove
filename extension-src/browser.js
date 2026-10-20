/* Browser-only privileged controller. No endpoint keys, transport, or UI state. */
const attached = new Map();
const starterTabs = new Set();
let activeTabId;
let notifier = () => {};
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function notice(event, data) {
  try { const result = notifier(event, data); if(result && typeof result.catch === 'function')result.catch(()=>{}); }
  catch { /* A consumer must not break Chrome event dispatch. */ }
}
function notifyBrowserEvent(message) { const {type, ...data}=message; notice('browser_notice',data); }
/** Register (event, data) notifications: tabs -> TabInfo[], browser_notice -> detail. */
export function setNotifier(callback) {
  notifier = typeof callback === 'function' ? callback : () => {};
}

/** Manual tool calls retain their debugger while a user-visible modal is open. */
export function hasPendingDialogs() {
  return [...attached.values()].some(state => !!state.dialog);
}

/** Startup-only recovery after Chrome forcibly terminates the MV3 worker.
 * Chrome retains extension-owned debugger clients beyond the worker's globals.
 * Detach resolves a client by BOTH target and calling extension ID; attempts
 * against DevTools/other extensions fail without closing those clients.
 * See Chromium debugger_api.cc: DebuggerDetachFunction -> InitClientHost ->
 * FindClientHost (client_host->extension_id() == extension()->id()).
 */
export async function recoverSessions() {
  const targets = await chrome.debugger.getTargets();
  let detached = 0;
  for(const target of targets) {
    if(!target.attached || target.type!=='page' || !Number.isInteger(target.tabId))continue;
    try { await chrome.debugger.detach({tabId:target.tabId});detached++; }
    catch { /* Not owned by this extension, restricted, or already closed. */ }
  }
  attached.clear();
  return {detached};
}

export async function listTabs() {
  return (await chrome.tabs.query({})).map(
    ({ id, url, title, active, windowId }) => ({
      id,
      url: url || "",
      title: title || "",
      active,
      windowId,
      controllable: canControl(url) || (starterTabs.has(id) && url === "about:blank"),
    }),
  );
}
function canControl(raw) {
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:", "file:"].includes(url.protocol) &&
      !isOwnPage(raw) &&
      !(
        url.hostname === "chromewebstore.google.com" ||
        (url.hostname === "chrome.google.com" &&
          url.pathname.startsWith("/webstore"))
      )
    );
  } catch {
    return false;
  }
}
function isOwnPage(raw) {
  try { const url=new URL(raw);return url.protocol==='chrome-extension:' && url.hostname===chrome.runtime.id; }
  catch { return false; }
}
function canControlTab(tab) {
  return !!tab && (canControl(tab.url) || (starterTabs.has(tab.id) && tab.url === 'about:blank'));
}
async function ensureTab(tabId) {
  let tab;
  if (tabId !== undefined && tabId !== null)
    tab = await chrome.tabs.get(Number(tabId));
  else if (activeTabId !== undefined) {
    try {
      tab = await chrome.tabs.get(activeTabId);
    } catch {}
  }
  if (!tab || !canControlTab(tab)) {
    if (tabId !== undefined && tabId !== null)
      throw new Error(
        "This tab is restricted. Rove cannot control its own app, Chrome internal pages, or the Chrome Web Store.",
      );
    const tabs = await chrome.tabs.query({});
    tab =
      tabs.find((t) => t.active && canControlTab(t)) ||
      tabs.find((t) => canControlTab(t));
  }
  if (!tab?.id || !canControlTab(tab))
    throw new Error(
      "No controllable tab. Open an ordinary website or use browser_navigate with newTab:true.",
    );
  activeTabId = tab.id;
  return tab;
}
function target(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}
function forgetSession(tabId, state, message = 'Browser session ended.') {
  if (!state || attached.get(tabId) !== state) return false;
  attached.delete(tabId);
  state.controller.abort(new Error(message));
  return true;
}
async function detachSession(tabId, state = attached.get(tabId)) {
  if (!forgetSession(tabId, state)) return;
  await chrome.debugger.detach({tabId}).catch(() => {});
}
function lostSession(tabId, state, reason) {
  if (forgetSession(tabId, state)) {
    notice('browser_notice', {event:'detached', tabId, reason});
  }
  return new Error('Chrome disconnected Rove from this tab. Check the page, then start the task again to reconnect. An action already sent may have completed; it was not replayed.');
}
function isMissingSession(error) {
  return /debugger is not attached|no tab with (?:given )?id|no target with (?:given )?id/i.test(errorMessage(error));
}
function isMissingChild(error) {
  return /session (?:with given id )?not found|no session|no target with (?:given )?id|target closed|session closed/i.test(errorMessage(error));
}
function forgetChild(state, sessionId) {
  state.sessions.delete(sessionId);
  for (const [key, value] of state.contexts)
    if (value.sessionId === sessionId) state.contexts.delete(key);
  state.epoch++;
}
// JPEG SOF records contain the actual encoded dimensions. Page DPR can differ
// from this debugger session's screenshot scale under browser emulation.
function jpegDimensions(base64) {
  const bytes = atob(base64);
  const byte = index => bytes.charCodeAt(index);
  if(byte(0)!==0xff || byte(1)!==0xd8)throw new Error('Chrome returned an invalid JPEG screenshot.');
  let offset=2;
  while(offset+3<bytes.length) {
    if(byte(offset)!==0xff)throw new Error('Chrome returned an invalid JPEG marker.');
    while(byte(offset)===0xff)offset++;
    const marker=byte(offset++);
    if(marker===0xd9 || marker===0xda)break;
    if(marker===0x01 || marker===0xd8 || marker>=0xd0 && marker<=0xd7)continue;
    const length=(byte(offset)<<8)|byte(offset+1);
    if(length<2 || offset+length>bytes.length)break;
    if(marker>=0xc0 && marker<=0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
      const height=(byte(offset+3)<<8)|byte(offset+4);
      const width=(byte(offset+5)<<8)|byte(offset+6);
      if(width>0 && height>0)return {width,height};
      break;
    }
    offset+=length;
  }
  throw new Error('Could not read the screenshot dimensions.');
}
async function cdp(tabId, method, params = {}, sessionId) {
  const state = attached.get(tabId);
  if (!state) {
    const error = new Error(`Browser session ended before dispatch (${method}, tab ${tabId}). Start the task again to reconnect.`);
    console.error('[Rove browser session]', {method, tabId, knownTabs:[...attached.keys()], stack:error.stack});
    throw error;
  }
  // Root detach notifications have no client/session generation. A notification
  // for an old client can arrive after its replacement attached. Gate dispatch
  // on the extension-scoped ownership probe instead of deleting the new state.
  if (state.detachCheck) await state.detachCheck;
  state.controller.signal.throwIfAborted();
  if (attached.get(tabId) !== state)
    throw new Error('Browser session changed before dispatch. Start the task again to reconnect.');
  if (sessionId && !state.sessions.has(sessionId))
    throw new Error('This frame changed. Read the page again before interacting with it.');
  const canWaitForDialog =
    /^(Input\.|Runtime\.(evaluate|callFunctionOn)|Page\.(navigate|reload|getFrameTree|createIsolatedWorld|captureScreenshot)|DOM\.setFileInputFiles)/.test(
      method,
    );
  const dialogError = () =>
    new Error(
      `A JavaScript ${state.dialog?.type || "modal"} dialog is open: ${String(state.dialog?.message || "").slice(0, 400)}. Use browser_dialog to accept or dismiss it before continuing.`,
    );
  if (state?.dialog && canWaitForDialog) throw dialogError();
  const command = chrome.debugger.sendCommand(
    target(tabId, sessionId),
    method,
    params,
  );
  let interrupt, timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      // A suspended renderer must not hold the serial command queue forever.
      // Detach cancels outstanding CDP work; never replay the browser action.
      // Settle this command's precise error before cancelling other waiters.
      reject(new Error(
        `Chrome timed out during ${method}. The tab may be suspended or paused. Bring it to the foreground and inspect it before retrying. The action was not replayed.`,
      ));
      if (sessionId) forgetChild(state, sessionId);
      else if (attached.get(tabId) === state) {
        lostSession(tabId, state, 'command_timeout');
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
    }, 15000);
  });
  let aborted;
  const cancelled = new Promise((_, reject) => {
    aborted = () => reject(state.controller.signal.reason);
    state.controller.signal.addEventListener('abort', aborted, {once:true});
  });
  const waits = [command, deadline, cancelled];
  if (state && canWaitForDialog)
    waits.push(
      new Promise((_, reject) => {
        interrupt = () => reject(dialogError());
        state.dialogWaiters.add(interrupt);
      }),
    );
  try {
    return await Promise.race(waits);
  } catch(error) {
    if (sessionId && isMissingChild(error)) {
      forgetChild(state, sessionId);
      throw new Error('This frame changed while Chrome was handling the request. Read the page again before interacting; the action was not replayed.');
    }
    if (isMissingSession(error)) throw lostSession(tabId, state, 'connection_lost');
    throw error;
  } finally {
    clearTimeout(timeout);
    state.controller.signal.removeEventListener('abort', aborted);
    if (interrupt) state.dialogWaiters.delete(interrupt);
  }
}
async function initializeSession(tabId, sessionId) {
  // Losing this error used to continue initialization after the timeout had
  // already disposed the client, masking the real failure as "session ended".
  await cdp(tabId, "Page.enable", {}, sessionId);
  await cdp(tabId, "Runtime.enable", {}, sessionId);
  await cdp(
    tabId,
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    },
    sessionId,
  ).catch(() => {});
}
async function attach(tabId, verify = false, recover = false) {
  const cached = attached.get(tabId);
  if (cached) {
    // Probe in the browser process, not the renderer. A JavaScript modal must
    // neither block preflight nor hide a disconnected, cached dialog session.
    try {
      if (verify) await cdp(tabId, 'Target.getTargetInfo');
      return cached;
    } catch (error) {
      if (!recover || attached.has(tabId)) throw error;
      // Only a new task's preflight may reconnect here. No tool action was sent.
    }
  }
  const state = {
    sessions: new Map(),
    contexts: new Map(),
    epoch: Date.now(),
    counter: 0,
    dialog: null,
    dialogWaiters: new Set(),
    controller: new AbortController(),
  };
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // A worker may lose its globals while Chrome retains this extension's client.
    // sendCommand is scoped to our extension: probing cannot claim DevTools/another extension.
    try { await chrome.debugger.sendCommand({tabId}, 'Target.getTargetInfo'); }
    catch {
      if (/already attached|another debugger/i.test(errorMessage(error)))
        throw new Error('Another debugger is using this tab. Close its DevTools or stop the other browser controller, then retry.');
      throw error;
    }
    // Start a clean protocol session so frame/context subscriptions are rebuilt.
    await chrome.debugger.detach({tabId});
    await chrome.debugger.attach({tabId}, "1.3");
  }
  attached.set(tabId, state);
  try {
    await initializeSession(tabId);
  } catch (error) {
    await detachSession(tabId, state);
    throw error;
  }
  return state;
}
chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  const state = attached.get(source.tabId);
  if (!state) return;
  if (method === "Page.javascriptDialogOpening") {
    state.dialog = params;
    for (const interrupt of [...state.dialogWaiters]) interrupt();
    notifyBrowserEvent({
      type: "browser_event",
      event: "dialog",
      tabId: source.tabId,
      dialogType: params.type,
      message: String(params.message || "").slice(0, 500),
    });
  } else if (method === "Page.javascriptDialogClosed") {
    state.dialog = null;
    notice('browser_notice', {event: 'dialog_closed', tabId: source.tabId});
  } else if (method === "Target.attachedToTarget") {
    state.sessions.set(params.sessionId, {
      frameId: params.targetInfo.targetId,
      parentSessionId: source.sessionId,
    });
    initializeSession(source.tabId, params.sessionId).catch((error) => {
      if (attached.get(source.tabId) !== state || !state.sessions.has(params.sessionId)) return;
      notice("browser_notice", {event:"error",tabId:source.tabId,message:errorMessage(error)});
    });
  } else if (method === "Target.detachedFromTarget") {
    forgetChild(state, params.sessionId);
  } else if (method === "Runtime.executionContextCreated") {
    const context = params.context;
    if (context.auxData?.frameId && context.auxData?.isDefault)
      state.contexts.set(context.auxData.frameId, {
        contextId: context.id,
        sessionId: source.sessionId,
      });
  } else if (method === "Runtime.executionContextDestroyed") {
    for (const [key, value] of state.contexts)
      if (
        value.contextId === params.executionContextId &&
        value.sessionId === source.sessionId
      )
        state.contexts.delete(key);
  } else if (method === "Runtime.executionContextsCleared") {
    for (const [key, value] of state.contexts)
      if (value.sessionId === source.sessionId) state.contexts.delete(key);
    state.epoch++; // Old element references are never reused across a document change.
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const state = attached.get(source.tabId);
  if (!state || state.detachCheck) return;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Debugger ownership check timed out.')), 3000);
  });
  state.detachCheck = Promise.race([
    chrome.debugger.sendCommand({tabId:source.tabId}, 'Target.getTargetInfo'),
    timeout,
  ]).then(
    () => {}, // A replacement client is healthy; this detach event was stale.
    () => { lostSession(source.tabId, state, reason); },
  ).finally(() => {
    clearTimeout(timer);
    state.detachCheck = undefined;
  });
});
async function framesFor(tabId) {
  const state = await attach(tabId),
    frames = [];
  const sessions = [undefined, ...state.sessions.keys()];
  for (const sessionId of sessions) {
    try {
      const result = await cdp(tabId, "Page.getFrameTree", {}, sessionId);
      if (sessionId && state.sessions.has(sessionId))
        state.sessions.get(sessionId).frameId = result.frameTree.frame.id;
      const walk = (node, parentId) => {
        const frame = node.frame;
        const existing = frames.find((f) => f.id === frame.id);
        if (!existing || sessionId) {
          const value = {
            id: frame.id,
            url: frame.url,
            name: frame.name || "",
            parentId: frame.parentId || parentId,
            sessionId,
          };
          if (existing) Object.assign(existing, value);
          else frames.push(value);
        }
        for (const child of node.childFrames || []) walk(child, frame.id);
      };
      walk(result.frameTree);
    } catch {}
  }
  return frames;
}
async function frameContext(tabId, frameId, mainWorld = false) {
  const frames = await framesFor(tabId);
  const frame = frameId
    ? frames.find((f) => f.id === frameId)
    : frames.find((f) => !f.parentId);
  if (!frame) throw new Error("Frame no longer exists. Take a fresh snapshot.");
  if (isOwnPage(frame.url))
    throw new Error(
      "Rove cannot inspect or control its own app, including an embedded frame.",
    );
  const state = attached.get(tabId);
  if (mainWorld) {
    const context = state.contexts.get(frame.id);
    if (context) return { ...frame, ...context };
    throw new Error(
      "Frame execution context is not ready. Retry after a fresh snapshot.",
    );
  }
  const result = await cdp(
    tabId,
    "Page.createIsolatedWorld",
    {
      frameId: frame.id,
      worldName: "Rove automation",
      grantUniveralAccess: false,
    },
    frame.sessionId,
  );
  return { ...frame, contextId: result.executionContextId };
}
async function evaluate(tabId, frame, expression, returnByValue = true) {
  const result = await cdp(
    tabId,
    "Runtime.evaluate",
    {
      expression,
      contextId: frame.contextId,
      returnByValue,
      awaitPromise: true,
      userGesture: true,
    },
    frame.sessionId,
  );
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Page JavaScript failed",
    );
  if (result.result.subtype === "error")
    throw new Error(result.result.description);
  return returnByValue ? result.result.value : result.result;
}
async function elementOperation(tabId, frameId, ref, body, extra = {}) {
  const frame = await frameContext(tabId, frameId);
  const expression = `(async()=>{const ref=${JSON.stringify(ref)},args=${JSON.stringify(extra)};const el=globalThis.__roveRefs?.get(ref);if(!el||!el.isConnected)throw new Error('Element reference is stale or belongs to another frame. Take a fresh snapshot.');${body}})()`;
  return { frame, result: await evaluate(tabId, frame, expression) };
}
function snapshotInPage(prefix, options) {
  globalThis.__roveRefs = new Map();
  const elements = [],
    textChunks = [],
    seen = new Set();
  let totalElements = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== "hidden" &&
      s.display !== "none"
    );
  };
  const name = (el) => {
    const labelled = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .trim();
    return (
      el.getAttribute("aria-label") ||
      labelled ||
      el.labels?.[0]?.textContent ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.getAttribute("name") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.shadowRoot) {
        if (visible(el))
          textChunks.push(el.shadowRoot.textContent?.slice(0, 4000) || "");
        walk(el.shadowRoot);
      }
      const tag = el.tagName.toLowerCase();
      if (!visible(el) || el.closest("[inert]")) continue;
      const interactive =
        el.matches(
          "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],[role=menuitem],[role=option],[role=tab],[role=slider],[role=switch],[role=spinbutton],[contenteditable=true]",
        ) || el.tabIndex >= 0;
      if (!interactive) continue;
      const r = el.getBoundingClientRect();
      const inViewport =
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth;
      if (options.viewportOnly && !inViewport) continue;
      const label = name(el);
      if (
        options.query &&
        !`${label} ${el.getAttribute("href") || ""}`
          .toLowerCase()
          .includes(options.query.toLowerCase())
      )
        continue;
      const index = totalElements++;
      if (
        index < options.elementOffset ||
        elements.length >= options.elementLimit
      )
        continue;
      const ref = prefix + ":" + (index + 1);
      globalThis.__roveRefs.set(ref, el);
      const role =
        el.getAttribute("role") ||
        {
          a: "link",
          button: "button",
          input:
            el.type === "checkbox"
              ? "checkbox"
              : el.type === "radio"
                ? "radio"
                : el.type === "button" || el.type === "submit"
                  ? "button"
                  : "textbox",
          textarea: "textbox",
          select: "combobox",
          summary: "button",
        }[tag] ||
        tag;
      const item = {
        ref,
        role,
        name: label,
        tag,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        inViewport,
      };
      if (tag === "a") item.href = el.href;
      if ("value" in el && el.type !== "password")
        item.value = String(el.value).slice(0, 300);
      if (el.disabled) item.disabled = true;
      if ("checked" in el) item.checked = el.checked;
      if (tag === "select")
        item.options = [...el.options].map((o) => ({
          value: o.value,
          label: o.label,
          selected: o.selected,
        }));
      elements.push(item);
    }
  };
  walk(document);
  const text =
    (document.body?.innerText || document.documentElement?.innerText || "") +
    "\n" +
    textChunks.join("\n");
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      coordinateSpace: "CSS pixels",
    },
    text: text.slice(
      options.textOffset,
      options.textOffset + options.textLimit,
    ),
    textOffset: options.textOffset,
    textLength: text.length,
    hasMoreText: options.textOffset + options.textLimit < text.length,
    elements,
    elementOffset: options.elementOffset,
    totalElements,
    hasMoreElements:
      options.elementOffset + options.elementLimit < totalElements,
  };
}
async function snapshot(tabId, frameId, args = {}) {
  const options = {
    textOffset: args.textOffset ?? 0,
    textLimit: args.textLimit ?? 6000,
    elementOffset: args.elementOffset ?? 0,
    elementLimit: args.elementLimit ?? 60,
    query: args.query || "",
    viewportOnly: !!args.viewportOnly,
  };
  for (const [key, min, max] of [
    ["textOffset", 0, Number.MAX_SAFE_INTEGER],
    ["textLimit", 100, 18000],
    ["elementOffset", 0, Number.MAX_SAFE_INTEGER],
    ["elementLimit", 1, 200],
  ]) {
    if (
      !Number.isSafeInteger(options[key]) ||
      options[key] < min ||
      options[key] > max
    )
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  }
  const tab = await ensureTab(tabId),
    frame = await frameContext(tab.id, frameId),
    state = attached.get(tab.id);
  const data = await evaluate(
    tab.id,
    frame,
    `(${snapshotInPage.toString()})(${JSON.stringify(`${state.epoch}-${++state.counter}`)},${JSON.stringify(options)})`,
  );
  const frames = await framesFor(tab.id);
  return {
    tabId: tab.id,
    ...data,
    frameId: frame.id,
    frames: frames.map(({ id, url, name, parentId }) => ({
      id,
      url,
      name,
      parentId,
    })),
  };
}
async function pointForRef(tabId, frameId, ref) {
  const { frame, result } = await elementOperation(
    tabId,
    frameId,
    ref,
    "el.scrollIntoView({block:'center',inline:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect();if(!b.width||!b.height)throw new Error('Element is not visible');return {x:b.x+b.width/2,y:b.y+b.height/2};",
  );
  // Dispatch native mouse input through the tab root. Box models are relative
  // to their owning target viewport; add each out-of-process target's embedding
  // offset, plus a same-process child frame offset when applicable.
  let x = result.x,
    y = result.y;
  const state = attached.get(tabId);
  let sessionId = frame.sessionId;
  const addOwner = async (frameId, parentSessionId) => {
    const owner = await cdp(
      tabId,
      "DOM.getFrameOwner",
      { frameId },
      parentSessionId,
    );
    const box = await cdp(
      tabId,
      "DOM.getBoxModel",
      { backendNodeId: owner.backendNodeId },
      parentSessionId,
    );
    x += box.model.content[0];
    y += box.model.content[1];
  };
  try {
    const targetRootId = sessionId
      ? state.sessions.get(sessionId)?.frameId
      : undefined;
    if (frame.parentId && frame.id !== targetRootId)
      await addOwner(frame.id, sessionId);
    const visited = new Set();
    while (sessionId) {
      if (visited.has(sessionId)) throw new Error("Cyclic frame target");
      visited.add(sessionId);
      const child = state.sessions.get(sessionId);
      if (!child) throw new Error("Frame target detached");
      await addOwner(child.frameId, child.parentSessionId);
      sessionId = child.parentSessionId;
    }
  } catch {
    throw new Error(
      "Cannot locate the iframe in its parent. Take a fresh frame snapshot or use root viewport coordinates.",
    );
  }
  return { x, y };
}
async function pointFromArgs(
  tabId,
  args,
  refKey = "ref",
  xKey = "x",
  yKey = "y",
  frameId = args.frameId,
) {
  const point = args[refKey]
    ? await pointForRef(tabId, frameId, args[refKey])
    : { x: args[xKey], y: args[yKey] };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error(
      `Pointer action requires ${refKey} or numeric ${xKey} and ${yKey}.`,
    );
  if (!args[refKey]) {
    const frame = await frameContext(tabId);
    const viewport = await evaluate(
      tabId,
      frame,
      "({width:innerWidth,height:innerHeight,devicePixelRatio})",
    );
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= viewport.width ||
      point.y >= viewport.height
    )
      throw new Error(
        `Coordinates (${point.x}, ${point.y}) are outside the ${viewport.width}x${viewport.height} CSS-pixel viewport. Map screenshot pixels through its actual imageSize and CSS captureBounds; page devicePixelRatio alone is not a reliable screenshot scale. Use a snapshot ref when possible.`,
      );
  }
  return point;
}
const keyDefinitions = {
  Enter: ["Enter", "Enter", 13, "\r"],
  Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27],
  Backspace: ["Backspace", "Backspace", 8],
  Delete: ["Delete", "Delete", 46],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  Home: ["Home", "Home", 36],
  End: ["End", "End", 35],
  PageUp: ["PageUp", "PageUp", 33],
  PageDown: ["PageDown", "PageDown", 34],
  Space: [" ", "Space", 32, " "],
};
async function pressKey(tabId, key, sessionId) {
  const parts = String(key).split("+"),
    raw = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 }[
      part
    ];
    if (!bit) throw new Error(`Unknown key modifier: ${part}`);
    modifiers |= bit;
  }
  const definition =
    keyDefinitions[raw] ||
    (raw.length === 1
      ? [
          raw,
          /[a-z]/i.test(raw)
            ? `Key${raw.toUpperCase()}`
            : /\d/.test(raw)
              ? `Digit${raw}`
              : raw,
          raw.toUpperCase().charCodeAt(0),
          raw,
        ]
      : undefined);
  if (!definition) throw new Error(`Unsupported key: ${raw}`);
  const [value, code, keyCode, text] = definition;
  const params = {
    key: value,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  };
  await cdp(
    tabId,
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      ...params,
      ...(text && !(modifiers & 7) ? { text, unmodifiedText: text } : {}),
    },
    sessionId,
  );
  await cdp(
    tabId,
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...params },
    sessionId,
  );
}
export async function perform(action, args = {}) {
  if (action === "browser_tabs") return listTabs();
  if (action === "browser_downloads") {
    if (args.action === "cancel") {
      if (!Number.isInteger(args.id))
        throw new Error("A numeric download id is required.");
      await chrome.downloads.cancel(args.id);
      return { canceled: args.id };
    }
    if (args.action !== "list")
      throw new Error("Download action must be list or cancel.");
    return (
      await chrome.downloads.search({ limit: 20, orderBy: ["-startTime"] })
    ).map(({ id, url, filename, state, bytesReceived, totalBytes, error }) => ({
      id,
      url,
      filename,
      state,
      bytesReceived,
      totalBytes,
      ...(error ? { error } : {}),
    }));
  }
  if (action === "browser_wait") {
    const milliseconds = Number(args.milliseconds);
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 10000
    )
      throw new Error("Wait must be between 0 and 10000 milliseconds.");
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { waited: milliseconds };
  }
  if (action === "browser_navigate") {
    if (!canControl(args.url))
      throw new Error(
        "Navigation requires an http, https, or file URL outside the Rove app and Chrome Web Store.",
      );
    let tab;
    if (args.newTab || (args.tabId === undefined && activeTabId === undefined))
      tab = await chrome.tabs.create({ url: "about:blank" });
    else tab = await ensureTab(args.tabId);
    activeTabId = tab.id;
    // Attach before navigating so on-load dialogs are observable, including
    // when the destination is the first page in a newly created tab.
    await attach(tab.id, true);
    const navigation = await cdp(tab.id, "Page.navigate", { url: args.url });
    if (navigation?.errorText)
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    await waitForLoad(tab.id);
    return snapshot(tab.id);
  }
  const tab = await ensureTab(args.tabId),
    tabId = tab.id;
  await attach(tabId, true);
  switch (action) {
    case "browser_snapshot":
      return snapshot(tabId, args.frameId, args);
    case "browser_screenshot": {
      // A hidden tab paints no frames, so capturing it hangs until Chrome times the command out.
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
        await settle();
      }
      const rootFrame = await frameContext(tabId);
      const viewport = await evaluate(
        tabId,
        rootFrame,
        "({width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,coordinateSpace:'CSS pixels'})",
      );
      const image = await cdp(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 75,
        captureBeyondViewport: false,
        clip: {x:viewport.scrollX,y:viewport.scrollY,width:viewport.width,height:viewport.height,scale:1},
      });
      return {
        tabId,
        url: tab.url,
        title: tab.title,
        viewport,
        imageSize: jpegDimensions(image.data),
        captureBounds: {x:0,y:0,width:viewport.width,height:viewport.height,pageX:viewport.scrollX,pageY:viewport.scrollY,coordinateSpace:'CSS pixels'},
        dataUrl: "data:image/jpeg;base64," + image.data,
      };
    }
    case "browser_click": {
      const point = await pointFromArgs(tabId, args);
      const button = args.button || "left";
      if (!["left", "right", "middle"].includes(button))
        throw new Error("Button must be left, right, or middle.");
      await cdp(
        tabId,
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: point.x, y: point.y },
        point.sessionId,
      );
      await cdp(
        tabId,
        "Input.dispatchMouseEvent",
        { type: "mousePressed", button, clickCount: 1, x: point.x, y: point.y },
        point.sessionId,
      );
      await cdp(
        tabId,
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          button,
          clickCount: 1,
          x: point.x,
          y: point.y,
        },
        point.sessionId,
      );
      await settle();
      return { clicked: true, tabId };
    }
    case "browser_hover": {
      const point = await pointFromArgs(tabId, args);
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await settle();
      return { hovered: true, tabId };
    }
    case "browser_drag": {
      const from = await pointFromArgs(
        tabId,
        args,
        "fromRef",
        "fromX",
        "fromY",
      );
      const to = await pointFromArgs(
        tabId,
        args,
        "toRef",
        "toX",
        "toY",
        args.toFrameId || args.frameId,
      );
      const steps = args.steps ?? 12;
      if (!Number.isInteger(steps) || steps < 1 || steps > 50)
        throw new Error("Drag steps must be an integer from 1 to 50.");
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x,
        y: from.y,
      });
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        buttons: 1,
        clickCount: 1,
        x: from.x,
        y: from.y,
      });
      try {
        for (let step = 1; step <= steps; step++) {
          await cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            buttons: 1,
            x: from.x + ((to.x - from.x) * step) / steps,
            y: from.y + ((to.y - from.y) * step) / steps,
          });
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      } finally {
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          buttons: 0,
          clickCount: 1,
          x: to.x,
          y: to.y,
        });
      }
      await settle();
      return { dragged: true, tabId };
    }
    case "browser_type": {
      let sessionId;
      if (args.ref) {
        const result = await elementOperation(
          tabId,
          args.frameId,
          args.ref,
          "el.focus();return true;",
        );
        sessionId = result.frame.sessionId;
      }
      if (args.clear) {
        const platform = await chrome.runtime.getPlatformInfo();
        await pressKey(
          tabId,
          platform.os === "mac" ? "Meta+A" : "Control+A",
          sessionId,
        );
        await pressKey(tabId, "Backspace", sessionId);
      }
      if (typeof args.text !== "string")
        throw new Error("text must be a string.");
      await cdp(tabId, "Input.insertText", { text: args.text }, sessionId);
      return { typed: true, characters: args.text.length, tabId };
    }
    case "browser_press_key":
      await pressKey(tabId, args.key);
      await settle();
      return { pressed: args.key, tabId };
    case "browser_scroll": {
      const point = {
        x: args.x ?? 200,
        y: args.y ?? 200,
        deltaX: args.deltaX ?? 0,
        deltaY: args.deltaY ?? 600,
      };
      if (Object.values(point).some((value) => !Number.isFinite(value)))
        throw new Error("Scroll coordinates and deltas must be numbers.");
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
      });
      await settle();
      return { scrolled: true, tabId };
    }
    case "browser_select": {
      if (
        !Array.isArray(args.values) ||
        args.values.some((value) => typeof value !== "string")
      )
        throw new Error("values must be an array of strings.");
      const { result } = await elementOperation(
        tabId,
        args.frameId,
        args.ref,
        "if(el.tagName!=='SELECT')throw new Error('Element is not a select');const missing=args.values.filter(v=>![...el.options].some(o=>o.value===v));if(missing.length)throw new Error('Unknown option values: '+missing.join(', '));for(const option of el.options)option.selected=args.values.includes(option.value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return [...el.selectedOptions].map(o=>o.value);",
        { values: args.values },
      );
      return { selected: result, tabId };
    }
    case "browser_close_tab":
      await detachSession(tabId);
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    case "browser_history": {
      if (args.direction === "reload") await cdp(tabId, "Page.reload");
      else {
        const history = await cdp(tabId, "Page.getNavigationHistory");
        const index =
          history.currentIndex +
          (args.direction === "back"
            ? -1
            : args.direction === "forward"
              ? 1
              : NaN);
        const entry = history.entries[index];
        if (!entry) throw new Error("No history entry in that direction.");
        if (!canControl(entry.url))
          throw new Error("History target is a restricted page.");
        await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
      }
      await waitForLoad(tabId);
      return snapshot(tabId);
    }
    case "browser_evaluate": {
      if (typeof args.code !== "string")
        throw new Error("code must be a JavaScript function body.");
      const frame = await frameContext(tabId, args.frameId, true);
      return {
        tabId,
        value: await evaluate(
          tabId,
          frame,
          `(async(args)=>{${args.code}\n})(${JSON.stringify(args.args || {})})`,
        ),
      };
    }
    case "browser_cdp": {
      if (typeof args.method !== "string")
        throw new Error("method is required.");
      // This deliberately powerful tool still cannot navigate into Rove or
      // attach to additional targets through a raw protocol bypass.
      if (/^(Target\.|Browser\.)/.test(args.method))
        throw new Error(
          "Raw Target and Browser methods are unavailable. Use tab tools.",
        );
      if (args.method === "Page.navigate" && !canControl(args.params?.url))
        throw new Error("Navigation target is restricted.");
      if (args.method === "Page.navigateToHistoryEntry")
        throw new Error(
          "Use browser_history so the destination can be checked.",
        );
      return await cdp(tabId, args.method, args.params || {}, args.sessionId);
    }
    case "browser_dialog": {
      await cdp(tabId, "Page.handleJavaScriptDialog", {
        accept: !!args.accept,
        ...(args.promptText === undefined
          ? {}
          : { promptText: String(args.promptText) }),
      });
      const state = attached.get(tabId);
      if (state) state.dialog = null;
      return { handled: true, tabId };
    }
    case "browser_upload": {
      if (
        !Array.isArray(args.files) ||
        args.files.some((file) => typeof file !== "string")
      )
        throw new Error("files must contain absolute local file paths.");
      const frame = await frameContext(tabId, args.frameId);
      const object = await evaluate(
        tabId,
        frame,
        `(()=>{const el=globalThis.__roveRefs?.get(${JSON.stringify(args.ref)});if(!el||!el.isConnected)throw new Error('Stale reference');if(el.tagName!=='INPUT'||el.type!=='file')throw new Error('Element is not a file input');return el})()`,
        false,
      );
      try {
        await cdp(
          tabId,
          "DOM.setFileInputFiles",
          { objectId: object.objectId, files: args.files },
          frame.sessionId,
        );
      } finally {
        await cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId: object.objectId },
          frame.sessionId,
        ).catch(() => {});
      }
      return { uploaded: args.files.length, tabId };
    }
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 200));
}
async function waitForLoad(tabId) {
  const start = Date.now();
  await settle();
  while (Date.now() - start < 12000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await settle();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
export async function detachAll() {
  for (const [tabId, state] of [...attached]) await detachSession(tabId, state);
}

/** Attach before model I/O, keeping the MV3 service worker alive for the run.
 * An omitted target may create a blank starter tab if no ordinary tab exists.
 * The caller owns serial execution and must call detachAll when the run ends.
 */
export async function prepareRun(tabId) {
  let tab;
  if (tabId === null) {
    tab = await chrome.tabs.create({url:'about:blank'});
    starterTabs.add(tab.id);
    activeTabId=tab.id;
    await attach(tab.id, true, true);
    return {tabId:tab.id,url:tab.url||'',title:tab.title||''};
  }
  try { tab = await ensureTab(tabId); }
  catch(error) {
    if(tabId !== undefined && tabId !== null)throw error;
    tab = await chrome.tabs.create({url:'about:blank'});
    starterTabs.add(tab.id);
    activeTabId=tab.id;
  }
  // Background/frozen renderers can accept debugger.attach but never answer
  // Page.enable. Activate only at explicit task admission, before any action.
  await chrome.tabs.update(tab.id, {active:true});
  await attach(tab.id, true, true);
  return {tabId:tab.id,url:tab.url||'',title:tab.title||''};
}
let tabsTimer;
function broadcastTabs() {
  clearTimeout(tabsTimer);
  tabsTimer=setTimeout(()=>listTabs().then(tabs=>notice('tabs',tabs)).catch(error=>notice('browser_notice',{event:'error',message:errorMessage(error)})),150);
}
chrome.tabs.onCreated.addListener(broadcastTabs);
chrome.tabs.onRemoved.addListener(tabId=>{starterTabs.delete(tabId);if(activeTabId===tabId)activeTabId=undefined;broadcastTabs();});
chrome.tabs.onActivated.addListener(broadcastTabs);
chrome.tabs.onUpdated.addListener((id,info)=>{if(info.url || info.status==='complete' || info.title)broadcastTabs();});
