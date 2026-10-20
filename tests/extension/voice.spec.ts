import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

let context: BrowserContext, ui: Page;
test.beforeAll(async () => {
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.addInitScript(() => {
    Object.defineProperty(navigator.permissions, "query", { value: async () => ({ state: localStorage.getItem("test-mic-prompt") ? "prompt" : "granted" }) });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      if (localStorage.getItem("test-mic-denied")) throw new DOMException("Denied", "NotAllowedError");
      localStorage.removeItem("test-mic-prompt");
      return { getTracks: () => [{ stop() {} }] };
    } });
    class MockAudioContext {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 256, disconnect() {}, getByteTimeDomainData(samples: Uint8Array) { samples.forEach((_, index) => samples[index] = 128 + Math.sin(index / 8) * 40); } }; }
      async resume() {} async close() {}
    }
    (window as any).AudioContext = MockAudioContext;
    class MockRecognition {
      continuous = false; interimResults = false; lang = "";
      onstart?: () => void; onend?: () => void; onresult?: (event: any) => void;
      constructor() { (window as any).testRecognizer = this; }
      start() { (window as any).testStarts = ((window as any).testStarts || 0) + 1; setTimeout(() => this.onstart?.(), 0); }
      stop() { this.onend?.(); }
      abort() {}
    }
    (window as any).webkitSpeechRecognition = MockRecognition;
    class MockRecorder {
      static isTypeSupported() { return true; }
      state = "inactive";
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["mock opus audio"], { type: "audio/webm" }) });
        queueMicrotask(() => this.onstop?.());
      }
    }
    (window as any).MediaRecorder = MockRecorder;
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html?view=tab`);
  await expect(ui.getByRole("button", { name: "Start dictation" })).toBeVisible();
});
test.afterAll(async () => { await context?.close(); });

async function begin() {
  const pages = context.pages().length;
  await ui.getByRole("button", { name: "Start dictation" }).click();
  expect(context.pages()).toHaveLength(pages);
  return ui;
}
async function words(capture: Page, text: string) {
  await capture.evaluate(text => (window as any).testRecognizer.onresult({ results: [{ 0: { transcript: text }, isFinal: false }] }), text);
}
test("dictation inserts at the selection, stays unsent, and cancels with Escape", async () => {
  const prompt = ui.getByRole("textbox", { name: "Task prompt" });
  await prompt.fill("Find  today");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
  let capture = await begin();
  await expect(ui.getByRole("button", { name: "Stop dictation" })).toBeVisible();
  await expect(ui.getByRole("img", { name: "Live microphone waveform" })).toBeVisible();
  const order = await ui.locator('.usage-ring, .composer-controls > .voice-button, .run-button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  expect(order[0]).toBeLessThan(order[1]); expect(order[1]).toBeLessThan(order[2]);
  await words(capture, "red pandas");
  await expect(prompt).toHaveValue("Find red pandas today");
  await ui.getByRole("button", { name: "Stop dictation" }).click();
  await expect(ui.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await expect(prompt).toHaveValue("Find red pandas today");
  expect(await ui.evaluate(async () => (await chrome.runtime.sendMessage({ type: "relay-api", path: "/api/state", method: "GET" })).data.runs)).toHaveLength(0);
  capture = await begin();
  await expect(ui.getByRole("button", { name: "Stop dictation" })).toBeVisible();
  await ui.setViewportSize({ width: 320, height: 850 });
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = await ui.locator('.usage-ring, .composer-controls > .voice-button, .run-button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y));
  expect(Math.max(...row) - Math.min(...row)).toBeLessThan(2);
  await ui.screenshot({ path: "test-results/voice-recording.png" });
  await words(capture, "cancel this");
  await ui.keyboard.press("Escape");
  await expect(prompt).toHaveValue("Find red pandas today");
  await expect(ui.getByRole("button", { name: "Start dictation" })).toBeVisible();
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("denied permission is reported inline and leaves the draft intact", async () => {
  await ui.evaluate(() => localStorage.setItem("test-mic-denied", "true"));
  await begin();
  await expect(ui.getByRole("alert")).toContainText("Microphone permission denied");
  await expect(ui.getByRole("textbox", { name: "Task prompt" })).toHaveValue("Find red pandas today");
  await ui.evaluate(() => localStorage.removeItem("test-mic-denied"));
});
test("API dictation uses only the voice key and configured backend; settings persist", async () => {
  await ui.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: "relay-api", path: "/api/settings", method: "GET" });
    await chrome.runtime.sendMessage({ type: "relay-api", path: "/api/settings", method: "PUT", body: { ...response.data.settings, apiKey: "model-secret" } });
  });
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("combobox", { name: "Dictation backend" }).click();
  await ui.getByRole("option", { name: "Groq / compatible API" }).click();
  await ui.getByLabel("Voice API key", { exact: false }).fill("voice-secret");
  await expect(ui.getByRole("button", { name: /Save voice settings/ })).toHaveCount(0);
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => ui.evaluate(async () => (await chrome.storage.local.get("voiceApiKey")).voiceApiKey)).toBe("voice-secret");
  expect(await ui.evaluate(async () => (await chrome.storage.local.get("modelApiKey")).modelApiKey)).toBe("model-secret");
  await ui.reload();
  // The workbench is the initial view after reload.
  let uploads = 0;
  await context.route("https://api.groq.com/openai/v1/audio/transcriptions", async route => {
    uploads++;
    expect(route.request().headers().authorization).toBe("Bearer voice-secret");
    expect(route.request().headers()["content-type"]).toContain("multipart/form-data;");
    expect(route.request().postDataBuffer()?.toString()).toContain("whisper-large-v3-turbo");
    await route.fulfill({ json: { text: "dictated task" } });
  });
  const prompt = ui.getByRole("textbox", { name: "Task prompt" });
  await prompt.fill("");
  const starts = await ui.evaluate(() => (window as any).testStarts);
  await begin();
  await expect(ui.getByRole("button", { name: "Stop dictation" })).toBeVisible();
  expect(await ui.evaluate(() => (window as any).testStarts)).toBe(starts);
  await ui.getByRole("button", { name: "Stop dictation" }).click();
  await expect(prompt).toHaveValue("dictated task");
  await expect(ui.getByRole("button", { name: "Start dictation" })).toBeVisible();
  expect(uploads).toBe(1);
  const state = await ui.evaluate(async () => (await chrome.runtime.sendMessage({ type: "relay-api", path: "/api/state", method: "GET" })).data);
  expect(state.runs).toHaveLength(0);
  expect(JSON.stringify(state)).not.toContain("voice-secret");
  await ui.setViewportSize({ width: 320, height: 850 });
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ui.screenshot({ path: "test-results/voice-light.png" });
  const theme = ui.getByRole("button", { name: /dark|light/i });
  if (await theme.count()) await theme.first().click();
  await ui.screenshot({ path: "test-results/voice-dark.png" });
});
test("permission setup opens only once, and subsequent dictation stays inline", async () => {
  await ui.evaluate(() => chrome.storage.local.set({ voiceSettings: { backend: "web" } }));
  await ui.evaluate(() => localStorage.setItem("test-mic-prompt", "true"));
  const popup = context.waitForEvent("page");
  await ui.getByRole("button", { name: "Start dictation" }).click();
  const permission = await popup;
  await expect(ui.getByRole("button", { name: "Stop dictation" })).toBeVisible();
  await expect.poll(() => permission.isClosed()).toBe(true);
  await ui.keyboard.press("Escape");
  await begin();
  await expect(ui.getByRole("button", { name: "Stop dictation" })).toBeVisible();
  await ui.keyboard.press("Escape");
});
