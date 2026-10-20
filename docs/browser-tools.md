# Browser tools and extension contract

The Chrome extension contains both the agent runtime and browser controller. The runtime validates model tool inputs and decides which actions are enabled. All browser action names begin with `browser_`. The reusable controller lives in `extension-src/browser.js`; `extension/` is the generated installable output. Advanced operations may be disabled in the agent's tool configuration.

## Controller integration

Build the extension, load the generated `extension/` directory as an unpacked extension in Chrome's extensions page with Developer mode enabled, and configure the model endpoint in Relay. The complete runtime runs inside Chrome without a companion process.

The browser module exports:

- `prepareRun(tabId?)` selects and attaches the run's target **before the first model request**, returning `{tabId, url, title}`. Active debugger sessions keep the MV3 worker alive. When no target is supplied and no ordinary tab exists, it creates and attaches a blank starter tab; an explicit restricted target is rejected.
- `perform(action, args?)` executes one browser operation and returns its result or throws an actionable error. The caller owns serial scheduling and cancellation.
- `listTabs()` returns the browser's current tab inventory.
- `detachAll()` releases all attached debugger sessions at the end of a run.
- `hasPendingDialogs()` reports whether a tracked JavaScript modal is open, allowing manual operations to retain their debugger until the dialog is handled.
- `recoverSessions()` is a startup-only cleanup after persisted interrupted runs are marked failed. It discovers attached page targets, attempts caller-scoped debugger detachment, and returns `{detached}`. Run it before accepting new tasks or listing targets; never invoke it during an active task.
- `setNotifier(callback)` registers a callback receiving `(event, data)`. `tabs` delivers an array of tab records; `browser_notice` delivers `{event: "dialog" | "detached" | "error", tabId?, ...details}`.

```js
import {prepareRun, perform, detachAll, setNotifier} from './browser.js';

setNotifier((event, data) => recordBrowserEvent(event, data));
const target = await prepareRun(selectedTabId);
try {
  // Start model requests only after the target is attached.
  const snapshot = await perform('browser_snapshot', {tabId: target.tabId});
  // Supply snapshot to the agent and dispatch its validated browser actions.
} finally {
  await detachAll();
}
```

Dialog notices include `dialogType` and a bounded `message`; detach notices include `reason`. `dialog_closed` notices indicate when a manual modal session may be released. Notification failures do not interrupt browser event handling. The controller contains no model configuration, credentials, UI messaging, runtime bootstrap, or service-worker alarms. Those are runtime responsibilities.

Forced service-worker termination can leave Chrome's extension-owned debugger session attached even though JavaScript maps were lost. Startup recovery releases those orphaned sessions and never replays the interrupted task. The public target inventory does not identify a debugger's owner, so recovery attempts detachment and ignores ownership errors. Chromium's `DebuggerDetachFunction` resolves a client through `InitClientHost` and `FindClientHost`, which checks both target and calling extension ID; this prevents the cleanup from closing DevTools or another extension's debugger. [Chromium debugger implementation](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/debugger/debugger_api.cc)

## Tabs, frames, and references

Before using a cached debugger attachment, each browser operation probes the root session. If Chrome has disconnected it, Relay clears the stale cache and stops an active task. It does not replay the rejected command. A new task or manual observation acquires a fresh session. A detach notification stops an active task only when the user cancels Chrome's debugger banner or the tab the task is working in is lost. A different tab it used earlier, or a command timeout, is reported to the model on its next use instead.

Most tools accept an optional numeric `tabId`. An explicit ID is preferable: without one the bridge uses its last controlled tab, or chooses an active controllable tab. `browser_tabs` returns IDs, titles, URLs, active state, and a `controllable` flag. A tab listed by Chrome is not necessarily controllable.

`browser_snapshot` returns:

```js
{
  tabId, url, title, frameId, text, textOffset, textLength, hasMoreText,
  elements: [{ref, role, name, tag, x, y, width, height, value?, options?}],
  elementOffset, totalElements, hasMoreElements,
  frames: [{id, url, name, parentId?}]
}
```

The default snapshot covers the main document. Inspect an iframe by passing its ID as `frameId`. The inventory includes visible interactive elements, inferred roles, accessible labels, selected values, and open shadow roots. Password input values are omitted. This is a DOM-derived snapshot, not a complete accessibility tree.

Snapshots are paginated. `textOffset` defaults to 0 and `textLimit` to 6,000 characters; valid limits are 100–18,000. `textLength` reports the full available text length and `hasMoreText` indicates another text page. Read subsequent pages by incrementing `textOffset` by the previous limit. `elementOffset` defaults to 0 and `elementLimit` to 60; valid limits are 1–200. `totalElements` is the complete eligible interactive-element count and `hasMoreElements` indicates another inventory page. All offsets are nonnegative integers. Text and element pagination are independent, so a later text page can retain the first element page, or vice versa. Navigation/history snapshots use these same defaults.

An element `ref` is stored in a document-local map in an isolated execution world. It is not an injected DOM attribute or a CSS selector. **Take a fresh snapshot after navigation or a new snapshot of the same frame.** Previous references in that frame are invalidated, including when reading another pagination page; use a reference from the latest snapshot. Pass the same `frameId` when acting on an iframe reference. Stale/disconnected nodes produce an error rather than silently matching a different element.

## Operation reference

| Action               | Arguments                                                                                                       | Result / behavior                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `browser_tabs`       | none                                                                                                            | Tab inventory                                                                                                |
| `browser_navigate`   | `url`, optional `tabId`, `newTab`                                                                               | Navigate or create a tab; returns a snapshot with its `tabId`                                                |
| `browser_snapshot`   | optional `tabId`, `frameId`, `textOffset`, `textLimit`, `elementOffset`, `elementLimit`                         | Read a page of selected-document text and interactive elements, with pagination metadata                     |
| `browser_screenshot` | optional `tabId`                                                                                                | `{dataUrl, title, url, tabId}`; viewport JPEG                                                                |
| `browser_click`      | `ref` or numeric `x` + `y`; optional `tabId`, `frameId`, `button`                                               | Scroll ref into view, then native mouse input; button is `left`, `middle`, or `right`                        |
| `browser_hover`      | `ref` or numeric `x` + `y`; optional `tabId`, `frameId`                                                         | Native mouse movement to the target                                                                          |
| `browser_drag`       | `fromRef` or `fromX` + `fromY`, and `toRef` or `toX` + `toY`; optional `tabId`, `frameId`, `toFrameId`, `steps` | Native left-button pointer drag; 1–50 interpolated steps, default 12                                         |
| `browser_type`       | `text`; optional `ref`, `clear`, `tabId`, `frameId`                                                             | Focus a ref if supplied; native text insertion. `clear` selects existing content and presses Backspace first |
| `browser_press_key`  | `key`; optional `tabId`                                                                                         | Native keyboard input to the focused element                                                                 |
| `browser_scroll`     | optional `x`, `y`, `deltaX`, `deltaY`, `tabId`                                                                  | Native wheel input; defaults: position 200,200 and deltaY 600                                                |
| `browser_select`     | `ref`, `values: string[]`; optional `tabId`, `frameId`                                                          | Select option values; dispatch input/change events                                                           |
| `browser_wait` | `milliseconds` | Bounded 0–10,000 ms delay; the extension runtime may implement this locally |
| `browser_close_tab`  | `tabId`                                                                                                         | Close the permitted tab                                                                                      |
| `browser_history`    | `direction`: `"back"`, `"forward"`, or `"reload"`; optional `tabId`                                             | Checked navigation; returns a new snapshot                                                                   |
| `browser_dialog`     | `accept`; optional `promptText`, `tabId`                                                                        | Handle an already-open JavaScript alert, confirm, or prompt                                                  |
| `browser_upload`     | `ref`, `files: string[]`; optional `tabId`, `frameId`                                                           | Set files on an `<input type="file">` using local paths                                                      |
| `browser_downloads`  | `action`: `"list"` or `"cancel"`; `id` required for cancel                                                      | Last 20 download metadata records or cancel an in-progress download; does not read file contents             |
| `browser_evaluate`   | `code`; optional `args`, `tabId`, `frameId`                                                                     | Execute an async JavaScript body in that page/frame's main world                                             |
| `browser_cdp`        | `method`; optional `params`, `tabId`, `sessionId`                                                               | Send an advanced permitted CDP command                                                                       |

Keyboard names include `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, and single characters. Modifiers use `+`, for example `Control+A`, `Meta+A`, or `Shift+Tab`. Complex OS shortcuts and function keys are not implemented.

Click, hover, drag, typing, key, and wheel tools use CDP input instead of calling `HTMLElement.click()`. Explicit pointer coordinates are in the root tab's viewport. A drag's `frameId` identifies its source reference and `toFrameId` identifies its destination; the destination defaults to `frameId`. Keep both drag endpoints in view. This is a native pointer sequence, not a generic HTML5 `DataTransfer` synthesis API. Select uses DOM selection plus the conventional input/change events. There is no automatic retry of a potentially destructive click; inspect the result before repeating it.

Download records contain `{id, url, filename, state, bytesReceived, totalBytes, error?}`. Download listing covers the browser's recent download history rather than just the selected tab and requires Chrome's `downloads` permission. It provides metadata and cancelation, not file reading or a remote file transfer API.

## Custom JavaScript and CDP

JavaScript is a function **body**, not just an expression; `return` and `await` work, and JSON arguments are available as `args`:

```json
{
  "code": "const item = document.querySelector(args.selector); return item ? item.textContent.trim() : null;",
  "args": { "selector": "h1" },
  "tabId": 123
}
```

Return JSON-serializable data. Page exceptions become tool errors. These scripts execute in the page world, so page globals are available; snapshot element maps belong to the separate isolated world and are not available to custom scripts. JavaScript and raw CDP are explicit power tools, not a sandbox for untrusted code.

`browser_cdp` accepts protocol method names such as `DOM.getDocument`. Chrome restricts available domains. Relay additionally rejects raw `Target.*`, `Browser.*`, and `Page.navigateToHistoryEntry` commands; use its tab/history tools instead. `Page.navigate` receives URL checks. Child CDP session IDs are advanced transport identifiers, distinct from frame IDs.

## Limits and failure recovery

- Chrome 125+ is required. Debugger permissions produce Chrome's visible permission/control indicators. Opening DevTools, closing a tab, browser policy, or canceling the debugging banner can detach the session.
- Relay refuses its own extension pages, Chrome internals, and Chrome Web Store pages. It also rejects snapshots/evaluation of an embedded Relay extension frame. Ordinary localhost sites remain controllable. Advanced JavaScript is deliberately powerful and can initiate navigation; subsequent operations still check the resulting target.
- Same-process iframe coordinates are adjusted using the embedding frame. Out-of-process iframes have child sessions; native pointer targets are translated through their embedding frames to the root viewport. Deeply nested/transformed frame geometry requires testing against the target site; use fresh frame snapshots when an interaction fails.
- Open shadow roots are traversed. Closed shadow roots, canvas-only controls, inaccessible inputs, browser menus, OS dialogs, browser authentication prompts, and CAPTCHA challenges are not universally covered.
- Screenshots capture the viewport rather than an arbitrarily large full-page image. Vision support depends on the configured model endpoint.
- Uploads require an actual file-input reference and accessible local files. A hidden upload input may need a custom script or advanced DOM/CDP inspection. This does not operate the OS file picker.
- Stop prevents the agent from scheduling further actions. An action already dispatched to Chrome may finish; actions are not rolled back. After a protocol timeout or debugger detachment, inspect browser state before retrying.
- A navigation waits up to roughly 12 seconds for load completion; highly dynamic pages may need another snapshot or a bounded wait. A failed frame/context/ref should be rediscovered, not guessed.
- If an action opens a JavaScript dialog, Relay reports an actionable tool error and leaves the dialog visible. Use `browser_dialog` next; the pending native input or script may complete after it is handled. This prevents the serial command queue from deadlocking on a modal.

## Focused snapshots and coordinates

Snapshots accept `query` (case-insensitive accessible-name/link match) and `viewportOnly`. Pagination offsets apply to the filtered set. Purely structural roles such as group, text and main are not listed as interactive unless independently focusable. Each element includes `inViewport`; links include `href`. Snapshot and screenshot results include viewport width/height, `devicePixelRatio`, and the CSS coordinate space.

A screenshot reports the actual JPEG dimensions as `imageSize`, read from its encoded header. `captureBounds` describes the captured rectangle in viewport CSS pixels (`x`, `y`, `width`, `height`) and its document origin (`pageX`, `pageY`). Map an image-pixel point to pointer coordinates using `x = captureBounds.x + imageX * captureBounds.width / imageSize.width` and the equivalent formula for `y`. Do not infer this mapping from page `devicePixelRatio`: Chrome emulation can give the page and debugger capture different scales. The screenshot uses an explicit clip of the current viewport, including its scroll offset. Explicit pointer coordinates outside the CSS viewport fail with an actionable error. References remain preferable: the extension scrolls and remeasures their centre at dispatch time.
