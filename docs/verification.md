# V1 verification

Verified locally on Windows on **2026-10-20**, with Node.js 24 and Playwright Chromium 156. Chrome 125+ is the implementation's minimum; the integration test covers the installed test browser version.

- `npm run build`: TypeScript checking and production Vite build pass.
- `npm test`: **22 tests pass**, covering the agent/model loop, approval denial and cancellation, questions/replies, selected-tab routing, vision sequencing, schema validation, provider compatibility/errors, key redaction, long snapshot compaction, array tool results, historical configuration, and persistence/restart recovery including transient Windows file locks.
- `npm run test:e2e`: **2 integration tests pass**, exercising the actual MV3 extension, real browser page state, loopback backend, deterministic OpenAI-compatible model endpoint, and React interface.
- `npm audit`: no known vulnerabilities reported in the installed dependency tree at verification time.
- Production `npm start` smoke check: built interface loads successfully in Chromium, with no page errors, an empty task history, and no configured endpoint key or model. The local app is left running at port 4789 for handoff.

Real browser operations checked: pairing, native typing and click, selecting options, same-origin frame input, cross-site frame native click with site isolation enabled, screenshots, native hover and drag, JavaScript confirmation dialog recovery, download listing, and long-page text/element pagination. The model loop actually fills, submits and verifies a greeting form through browser tools, pausing for approvals. The UI starts a question task and resumes it after an answer. Tests also verify request/result traces, automatic screenshot rendering, mobile overflow, cross-origin request rejection, unpaired socket rejection, secret omission from settings, and rejection of manual snapshots during a run so approved refs remain valid.

Desktop and mobile layouts were visually inspected. Screenshots in `docs/screenshots/` show real test runs and fixture pages, with the test provider explicitly identified.

An external paid provider was **not** used: the user did not supply an endpoint/model/key. The included **Test connection** action verifies your chosen endpoint's function-calling response. Successful task execution still depends on that model's capability and the target website. The extension has been tested in isolated Chromium; installing and pairing it in the user's regular Chrome remains a one-time setup step.

The source repository includes CI commands for Linux. The CI workflow has been authored but was not executed on GitHub in this session. No repository was published or pushed remotely.
