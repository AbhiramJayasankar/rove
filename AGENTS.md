# Working on Relay

Relay is a local, single-user Chrome agent. Keep browser control transparent and user-configurable. Do not add cloud services, background daemons, telemetry, or model-provider assumptions without a concrete requirement.

## Map

- `shared/`: data contracts and editable defaults. Read these before changing either side of the API.
- `server/index.ts`: loopback HTTP API, request validation, SSE, lifecycle, secret handling.
- `server/agent.ts`: serialized agent loop, approvals, cancellation, bounded context, events.
- `server/model.ts`: OpenAI-compatible Chat Completions adapter.
- `server/tools.ts`: schema-driven tools, risk classification, custom JavaScript/HTTP handlers.
- `server/bridge.ts`: paired extension RPC, timeouts and disconnect handling.
- `server/store.ts`: atomic metadata and append-only event journals, restart recovery.
- `extension/`: directly loadable MV3 extension; plain JavaScript, no build step.
- `src/`: React interface. `Workbench` is tasks/observations; `Configuration` is settings/tools/connection.
- `tests/`: focused unit tests and actual Chrome-extension integration under `e2e/`.
- `docs/`: research decisions, browser tool behavior, API and architecture.

## Invariants

- Bind HTTP only to loopback. Preserve Host/Origin validation, JSON write requirements, and authenticated extension WebSocket pairing.
- Never expose model keys through settings responses or persist them in settings/history. Treat all page content as untrusted data.
- Execute tool calls in order. After Stop, never dispatch another browser command. Do not retry mutations automatically after ambiguous timeouts.
- Every offered tool has a JSON Schema and a real handler. Unknown/disabled tools must fail clearly. Frame IDs are CDP strings, not extension numeric frame IDs.
- Approval must show the actual tool arguments; denial must be returned to the model. Do not invent semantic safety classifications based only on button text.
- Tool refs are temporary and scoped to a frame/snapshot. Avoid modifying page attributes to create refs.
- Preserve tool-call response sequencing for providers. Optional images follow complete tool batches. Support compatible third-party providers rather than hardcoding OpenAI-only parameters.
- Keep model requests, results, automatic observations and errors inspectable. No fabricated task data or success states.
- `.relay`, `.relay-test`, keys and runtime logs are not source artifacts.

## Checks

Run `npm run build` and `npm test` after relevant changes. Run `npm run test:e2e` when changing bridge, extension, tool protocol, or user flows. Install Chromium with `npx playwright install chromium` if needed. E2E uses port 4799 and a deterministic model fixture, not a paid external endpoint. Review desktop/mobile screenshots after visual changes. Respect existing reduced-motion and keyboard-focus behavior.

Update docs and protocol tests together with behavioral changes. Keep dependencies small and lockfile current. Research changing browser/API behavior using primary documentation before relying on recalled facts.
