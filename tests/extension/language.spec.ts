import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

let context: BrowserContext, ui: Page;
test.beforeAll(async () => {
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    locale: "zh-CN",
    viewport: { width: 420, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
});
test.afterAll(async () => { await context?.close(); });

test("follows the browser language, can be switched in Settings, and the choice persists", async () => {
  await expect(ui.locator("html")).toHaveAttribute("lang", "zh-CN");
  await ui.getByRole("button", { name: "设置", exact: true }).click();
  const titles = ui.locator(".settings-groups .row-title");
  await expect(titles).toHaveText(["模型", "指令", "浏览", "工具与网站", "搜索与语音", "已连接的应用", "外观", "备份"]);
  await ui.locator(".settings-groups").getByRole("button", { name: "外观", exact: true }).click();
  await ui.getByRole("combobox", { name: "语言" }).click();
  await ui.getByRole("option", { name: "繁體中文" }).click();
  await expect(ui.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(ui.getByRole("heading", { name: "外觀", level: 1 })).toBeVisible();
  await ui.getByRole("combobox", { name: "語言" }).click();
  await ui.getByRole("option", { name: "English" }).click();
  await expect(ui.getByRole("heading", { name: "Appearance", level: 1 })).toBeVisible();
  await ui.getByRole("button", { name: "All settings", exact: true }).click();
  await expect(titles).toHaveText(["Model", "Instructions", "Browsing", "Tools and sites", "Search and voice", "Connected apps", "Appearance", "Backup"]);
  await ui.reload();
  await expect(ui.locator("html")).toHaveAttribute("lang", "en");
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
