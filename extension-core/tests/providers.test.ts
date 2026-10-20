import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProviderStore } from "../../extension-src/providers";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let storage: Record<string, unknown>;
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = {};
  write = vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, structuredClone(values)); });
  vi.stubGlobal("chrome", { storage: { local: { get: async () => structuredClone(storage), set: write } } });
});
afterEach(() => vi.unstubAllGlobals());
it("migrates the existing provider without exposing its key in summaries", async () => {
  const providers = new ProviderStore();
  await providers.init({ ...DEFAULT_SETTINGS, baseUrl: "https://tokenharbor.ai/v1", model: "mimo" }, "original-secret");
  expect(providers.profiles).toHaveLength(1);
  expect(providers.connection(providers.activeId).key).toBe("original-secret");
  expect(providers.summaries()[0]).toMatchObject({ model: "mimo", hasApiKey: true });
  expect(JSON.stringify(providers.summaries())).not.toContain("original-secret");
  expect(storage.modelApiKey).toBe("original-secret");
});
it("keeps each endpoint/key/model paired across switches and a reload", async () => {
  const providers = new ProviderStore();
  const settings = { ...DEFAULT_SETTINGS, model: "shared", baseUrl: "https://first.example/v1" };
  await providers.init(settings, "first-secret"); const first = providers.activeId;
  const added = await providers.add({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, settings);
  const second = providers.activeId;
  await providers.saveCurrent({ ...added.settings, model: "shared" }, "second-secret", "Router");
  const selected = await providers.select(first, added.settings);
  expect(selected).toMatchObject({ key: "first-secret", settings: { baseUrl: settings.baseUrl, model: "shared" } });
  const reloaded = new ProviderStore(); await reloaded.init(selected.settings, selected.key);
  expect(reloaded.profiles).toHaveLength(2);
  expect((await reloaded.select(second, selected.settings)).key).toBe("second-secret");
  expect(reloaded.summaries().find(profile => profile.id === second)?.name).toBe("Router");
});
it("does not change selection or credentials when a storage commit fails", async () => {
  const providers = new ProviderStore(); await providers.init(DEFAULT_SETTINGS, "secret");
  const before = providers.activeId;
  write.mockRejectedValueOnce(new Error("Disk full"));
  await expect(providers.add({ name: "Second", baseUrl: "https://second.example/v1" }, DEFAULT_SETTINGS)).rejects.toThrow("Disk full");
  expect(providers.activeId).toBe(before); expect(providers.profiles).toHaveLength(1);
  expect(providers.connection(before).key).toBe("secret");
});
it("deletes only the requested credential and retains at least one provider", async () => {
  const providers = new ProviderStore(); await providers.init(DEFAULT_SETTINGS, "first-secret");
  const first = providers.activeId;
  const added = await providers.add({ name: "Second", baseUrl: "https://second.example/v1" }, DEFAULT_SETTINGS);
  const second = providers.activeId;
  await providers.saveCurrent(added.settings, "second-secret");
  const selected = await providers.remove(second, added.settings);
  expect(providers.activeId).toBe(first); expect(selected.key).toBe("first-secret");
  expect(JSON.stringify(storage.modelProviderKeys)).not.toContain("second-secret");
  await expect(providers.remove(first, selected.settings)).rejects.toThrow("at least one");
});
