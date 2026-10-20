# Browser agent core

This directory contains the browser-only agent engine, model adapter, context management, tool registry and model catalogue. It shares the contracts in `shared/types.ts`. Runtime code uses Web Crypto, TextEncoder/TextDecoder, fetch, streams and AbortSignal; it has no Node imports or dynamic code generation. User JavaScript tool bodies are sent to the browser transport for page execution, rather than evaluated by the extension worker.

JSON Schema validation uses the interpreted `@cfworker/json-schema` validator so user-defined tools work under Manifest V3's extension CSP. `schema-meta.json` is the JSON Schema Draft 7 meta-schema used to validate tool definitions. Tool argument validation also recognizes explicit 2019-09/2020-12 schema declarations.

## Integration

`AgentEngine` retains the server engine's start/stop/approval/reply and live approval-mode interfaces. Its optional `checkpoint(): Promise<void>` callback must flush the durable run journal. The engine awaits it after recording model/tool events and before model requests, HTTP tools or browser dispatch. A rejected checkpoint terminates the run before further dispatch. Terminal event persistence is queued by `save`; the runtime must flush it before releasing run lifecycle resources.

`ModelCatalogue` defaults to `chrome.storage.local`. A compatible storage object may be passed as its first constructor argument; the second optional argument is its storage key, default `relay.modelProfiles.v1`.

1. Call and await `catalogue.init()` during runtime initialization.
2. `list(settings, key, refresh?, signal?)` and `resolve(settings, key, signal?)` fetch provider model metadata and establish the current credential identity.
3. `peek(settings, key)` is synchronous. It returns cached model metadata only when that endpoint and credential match the current registered identity; otherwise it returns null until list/resolve completes.
4. `learn(settings, key, inputBudget?, maxImages?)` and `reset(settings, key)` queue profile changes. Await `catalogue.flush()` before reporting a reset complete, at terminal run persistence, and when explicitly shutting down. Storage failures are observable through flush.

Only SHA-256 endpoint/credential identities are persisted with learned limits. Credentials and fetched model catalogues remain in worker memory. The runtime supplies authentication storage policy, IndexedDB journals, extension lifecycle management and the BrowserTransport implementation.

Run the browser-core regression suite from the repository root:

```sh
npx vitest run --config extension-core/vitest.config.ts
```

The suite reuses agent/context/model cases against this browser implementation and additionally covers CSP-safe tool validation, Unicode byte handling, hashed Chrome storage profiles and durable dispatch checkpoints.
