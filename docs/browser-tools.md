# Browser tools and extension contract

The extension executes browser actions; the backend validates model tool inputs and decides which actions are enabled. All browser action names begin with `browser_`. The following describes the actual bridge contract in `extension/background.js`, including advanced operations that may be disabled in the agent's tool configuration.

## Connection

1. Start Relay locally.
2. Load the `extension/` directory as an unpacked extension in Chrome's extensions page with Developer mode enabled.
3. Open the Relay extension popup, enter the local app address and pairing token from Relay settings, and connect.

The popup accepts an `http://` or `ws://` loopback address on a configurable port, for example `http://127.0.0.1:4789`. Only `127.0.0.1` and `localhost` are accepted as connection hosts. Credentials and URL paths are not used to change the bridge route. The extension connects to `/bridge?token=...` over WebSocket. Disconnect releases all attached debugger sessions and disables automatic reconnection until configured again.

The first outgoing message is `{type:"hello", browser:"Chrome", tabs:[...]}`. Tab updates use `{type:"tabs", tabs:[...]}`; the 20-second heartbeat uses `{type:"ping"}`. Commands use:

```json
{
  "type": "command",
  "id": "unique-request-id",
  "action": "browser_snapshot",
  "args": { "tabId": 123 }
}
```

Replies contain either `{type:"result", id, result}` or `{type:"result", id, error:"message"}`. IDs must be strings. Commands execute serially. A detached debugger also emits a `browser_event` with its tab ID and reason. A broken connection does not replay commands.

## Tabs, frames, and references

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
| `browser_wait`       | `milliseconds`                                                                                                  | Bounded 0–10,000 ms delay; backend may implement this locally                                                |
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
- Relay refuses its own configured loopback app port, Chrome internals, and Chrome Web Store pages. It also rejects snapshots/evaluation of an embedded Relay app frame. Advanced JavaScript is deliberately powerful and can initiate navigation; subsequent operations still check the resulting target.
- Same-process iframe coordinates are adjusted using the embedding frame. Out-of-process iframes have child sessions; native pointer targets are translated through their embedding frames to the root viewport. Deeply nested/transformed frame geometry requires testing against the target site; use fresh frame snapshots when an interaction fails.
- Open shadow roots are traversed. Closed shadow roots, canvas-only controls, inaccessible inputs, browser menus, OS dialogs, browser authentication prompts, and CAPTCHA challenges are not universally covered.
- Screenshots capture the viewport rather than an arbitrarily large full-page image. Vision support depends on the configured model endpoint.
- Uploads require an actual file-input reference and accessible local files. A hidden upload input may need a custom script or advanced DOM/CDP inspection. This does not operate the OS file picker.
- Stop prevents the agent from scheduling further actions. An action already dispatched to Chrome may finish; actions are not rolled back. After a transport timeout or disconnect, inspect browser state before retrying.
- A navigation waits up to roughly 12 seconds for load completion; highly dynamic pages may need another snapshot or a bounded wait. A failed frame/context/ref should be rediscovered, not guessed.
- If an action opens a JavaScript dialog, Relay reports an actionable tool error and leaves the dialog visible. Use `browser_dialog` next; the pending native input or script may complete after it is handled. This prevents the serial command queue from deadlocking on a modal.

## Focused snapshots and coordinates

Snapshots accept `query` (case-insensitive accessible-name/link match) and `viewportOnly`. Pagination offsets apply to the filtered set. Purely structural roles such as group, text and main are not listed as interactive unless independently focusable. Each element includes `inViewport`; links include `href`. Snapshot and screenshot results include viewport width/height, `devicePixelRatio`, and the CSS coordinate space.

A screenshot preserves native resolution. Divide image pixel coordinates by its reported device pixel ratio before issuing pointer input. Explicit pointer coordinates outside the CSS viewport fail with an actionable error. References remain preferable: the extension scrolls and remeasures their centre at dispatch time.
