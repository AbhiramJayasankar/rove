# Browser control research and decision

Research date: **2026-10-20**. This is a local single-user v1, designed around the user's existing Chrome profile, configurable OpenAI-compatible endpoints, editable instructions and tools, and inspectable execution.

## Decision

Use a **Manifest V3 Chrome extension with `chrome.debugger`**, an authenticated loopback WebSocket bridge, a local TypeScript agent backend, and a React control surface. Keep the browser transport independent of the model client and agent loop. This is a project design decision, not a claim that one transport wins for every browser-automation product.

The extension controls ordinary tabs in the browser where it is installed, retaining their existing authenticated sessions. It does not start Chrome with a second profile, export cookies, or require a public browser-control service. The backend keeps provider credentials out of the extension and avoids browser CORS restrictions on arbitrary model endpoints.

Chrome documents the debugger extension API as an alternate CDP transport. Its allowed protocol domains cover the DOM, page JavaScript, screenshots, native input, accessibility, networking, and frame targets. Some domains remain unavailable. Chrome 125 introduced flattened child sessions, and nested out-of-process frames require recursive attachment. [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

## Options considered

| Option                                              | Strengths                                                                                       | Tradeoff for this product                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Own MV3 debugger bridge                             | Own pairing, target selection, tool contract, diagnostics, and extension; uses existing profile | We maintain frame handling and browser operations; this is not all of Playwright                                 |
| Own agent UI with Playwright MCP extension mode     | Existing-profile access with a mature automation toolkit                                        | Requires another extension and server; less ownership of the browser-facing product                              |
| Chrome 144+ native remote-debugging permission flow | Official existing-session connection, no extension required                                     | User must enable remote debugging and approve the connection; a different setup/permission model                 |
| Playwright-managed persistent browser               | Mature lifecycle, locators, waits, and testing support                                          | Normally uses a separate automation profile; does not satisfy existing-profile access by default                 |
| Browser Use or Stagehand                            | Useful higher-level agent/action abstractions and CDP integration                               | Adds an opinionated agent layer when editable prompts, tools, and our own transparent loop are core requirements |
| Native messaging companion                          | Chrome launches a registered local host; extension origin allowlist                             | Installer and OS registration complexity are unnecessary for a source-distributed v1                             |

Playwright explicitly supports extension mode to reuse open tabs, cookies, and logged-in browser sessions. It also supports connecting to an existing Chrome or Edge by channel name. The existing official solution was considered; Rove chooses its own smaller operation contract because direct ownership and transparency are part of the requested product. [Playwright browser connections](https://playwright.dev/mcp/configuration/browser-extension)

**Important current correction:** it is inaccurate to say modern CDP can never access the regular Chrome profile. Chrome 144+ supports an explicit remote-debugging permission flow through `chrome://inspect/#remote-debugging`; Chrome DevTools MCP can request that connection using `--autoConnect`. This is a viable future Rove transport. [Chrome DevTools configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration), [Chrome's existing-session connection announcement](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

That newer permission flow differs from the Chrome 136 command-line restriction: `--remote-debugging-port` and `--remote-debugging-pipe` are ignored for the default data directory unless a nonstandard `--user-data-dir` is supplied. Chrome recommends Chrome for Testing for automation scenarios. [Chrome debugging-switch changes](https://developer.chrome.com/blog/remote-debugging-port)

Playwright also warns that `connectOverCDP` has lower fidelity than its native connection protocol and that the default Chrome data directory should not be passed to its persistent-context launcher. Rove uses Playwright's bundled Chromium for automated validation rather than trying to launch the user's regular Chrome profile. [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype), [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)

Browser Use exposes CDP connection and browser-profile configuration. Stagehand supports local and remote browser operation. Both remain reasonable future integrations; neither is needed to implement this product's provider-neutral tool loop. [Browser Use project guidance](https://github.com/browser-use/browser-use/blob/main/AGENTS.md), [Stagehand browser configuration](https://docs.stagehand.dev/v3/configuration/browser)

## Reliability and security decisions

- **Explicit local pairing:** loopback-only transport, pairing token, and extension-origin checks. The extension accepts only a local HTTP/WS address. A website is never given a general privileged command-forwarding channel.
- **Thin bridge:** JSON commands and JSON results with request IDs. Browser actions run serially so they do not race across tabs. The backend owns model retries and the agent state machine.
- **Lifecycle recovery:** the extension sends a heartbeat every 20 seconds, retries disconnected sockets with bounded backoff, and uses a Chrome alarm to recover after worker restarts. Settings persist in `chrome.storage.local`; pending operations are not replayed automatically after disconnect.
- **Inspectable events:** expose model-visible requests, tool calls, results, errors, and timings through the backend. Do not describe private model reasoning as observable. Keep provider secrets out of event payloads and browser tools.
- **Bounded execution:** schema-validated tools, bounded steps and waits, command/model timeouts, cancellation, and clear errors. One local process is sufficient; interfaces leave room to replace the browser transport or persistence later.
- **Power tools are explicit:** JavaScript and raw CDP provide extensibility but are not a security sandbox. They should be enabled deliberately. Regular navigation refuses Rove's own app, browser internals, and the Chrome Web Store.

The heartbeat follows Chrome's documented WebSocket keepalive pattern. Chrome 118+ also keeps workers alive while debugger sessions are active; workers still need restart resilience. [WebSocket service-worker guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets), [Extension worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

Chrome warns against forwarding arbitrary privileged network requests from page content. Rove installs no page content scripts or externally-connectable messaging channel. Native messaging could replace the socket for a packaged desktop edition, but requires host manifests, platform registration, and message-size handling. [Cross-origin request security](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

## Honest v1 boundaries

Browser control covers supported web-page content, not the whole operating system. Chrome settings pages, browser menus, protected pages, other extensions, OS file pickers, policy-blocked targets, and authentication challenges are not universal automation surfaces. A debugger session can also end when the user opens DevTools or cancels its banner; Rove releases state and reports the loss. Enterprise policies can prevent attachment. [Chrome debugger restrictions and detach events](https://developer.chrome.com/docs/extensions/reference/api/debugger)

The current snapshot is a bounded DOM-derived inventory with accessible labels, open shadow-root traversal, and explicit frame IDs. It is not a full accessibility-tree serializer or a Playwright locator engine. References expire when that frame is resnapshotted or navigated. Native hover and pointer dragging are supported, but nested-frame coordinate behavior, canvas-only interfaces, transformed frames, HTML5 data-transfer widgets, and complex editor keyboard shortcuts need site-specific testing. Screenshots plus coordinate actions and advanced tools provide alternatives, with model vision dependent on the configured endpoint.

File upload uses supplied local paths and a file-input reference. Download tools list recent metadata or cancel downloads; they do not read native file contents. File URL access remains subject to Chrome settings. Browser actions can have real effects in authenticated accounts; the UI's tool selection, approvals, stop control, and execution history are product features rather than claims that page content or arbitrary scripts can be made harmless.
