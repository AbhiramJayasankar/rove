import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";

// Rove works in tabs the user is not looking at: it opens them behind the current tab, collects them in a
// tab group, and Settings can turn either behaviour off. (Playwright reports every tab as visible, so the
// rendering of truly hidden tabs is checked against unmodified Chromium by hand; see docs/verification.md.)
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const tabInfo = (id: number) => ui.evaluate(async (id) => {
  const tab = await chrome.tabs.get(id);
  const group = tab.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : null;
  return { active: tab.active, groupId: tab.groupId, groupTitle: group?.title ?? null };
}, id);
const self = () => ui.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);
async function setBrowserSettings(patch: Record<string, boolean>) {
  const { settings } = await rpc("/api/state");
  await rpc("/api/settings", "PUT", { ...settings, ...patch });
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<title>Page ${request.url}</title><h1>${request.url}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a tab Rove opens stays behind the current tab, in a Rove group, and the user's own tab is left alone", async () => {
  const mine = await self();
  const opened = await rpc("/api/browser", "POST", { action: "browser_navigate", args: { url: origin + "/one", newTab: true } });
  expect(opened.tabId).not.toBe(mine);
  await expect.poll(() => tabInfo(opened.tabId)).toMatchObject({ active: false, groupTitle: "Rove" });
  expect((await tabInfo(mine)).active).toBe(true);
  expect((await tabInfo(mine)).groupId).toBe(-1);
  // Driving that hidden tab, including a screenshot, does not bring it forward.
  await rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: opened.tabId } });
  const shot = await rpc("/api/browser", "POST", { action: "browser_screenshot", args: { tabId: opened.tabId } });
  expect(shot.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect((await tabInfo(opened.tabId)).active).toBe(false);
  expect((await tabInfo(mine)).active).toBe(true);
});

test("Settings → Tools has the browsing switches, they save, and they take effect on the next tab", async () => {
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("button", { name: "Tools", exact: true }).click();
  const background = ui.getByRole("switch", { name: "Work in the background", exact: true });
  const group = ui.getByRole("switch", { name: "Group Rove's tabs", exact: true });
  const bar = ui.getByRole("switch", { name: "Keep going if I close Chrome's debugging bar", exact: true });
  for (const toggle of [background, group, bar]) await expect(toggle).toBeChecked();
  await ui.locator(".behavior-panel").screenshot({ path: "test-results/browsing-settings.png" });
  await background.uncheck();
  await group.uncheck();
  await bar.uncheck();
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings).toMatchObject({ backgroundTabs: false, groupTabs: false, keepGoingOnBarClose: false });

  const opened = await rpc("/api/browser", "POST", { action: "browser_navigate", args: { url: origin + "/two", newTab: true } });
  await expect.poll(() => tabInfo(opened.tabId)).toMatchObject({ active: true, groupId: -1 });

  await setBrowserSettings({ backgroundTabs: true, groupTabs: true, keepGoingOnBarClose: true });
  expect((await rpc("/api/state")).settings).toMatchObject({ backgroundTabs: true, groupTabs: true, keepGoingOnBarClose: true });
});
