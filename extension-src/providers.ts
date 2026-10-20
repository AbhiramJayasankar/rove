import { z } from "zod";
import type { Settings } from "../shared/types";

const profileSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(80),
  baseUrl: z.url().refine(value => ["https:", "http:"].includes(new URL(value).protocol) && !new URL(value).username && !new URL(value).password),
  model: z.string().max(200), reasoningEffort: z.string().default("default"),
});
type Profile = z.infer<typeof profileSchema>;
export class ProviderStore {
  profiles: Profile[] = [];
  activeId = "";
  private keys: Record<string, string> = {};
  async init(settings: Settings, key: string) {
    const saved = await chrome.storage.local.get(["modelProviders", "modelProviderKeys", "activeModelProviderId"]);
    const parsed = z.array(profileSchema).max(20).safeParse(saved.modelProviders);
    this.profiles = parsed.success ? parsed.data : [];
    const keys = z.record(z.string(), z.string().max(10000)).safeParse(saved.modelProviderKeys);
    this.keys = keys.success ? keys.data : {};
    this.activeId = typeof saved.activeModelProviderId === "string" && this.profiles.some(p => p.id === saved.activeModelProviderId) ? saved.activeModelProviderId : this.profiles[0]?.id || crypto.randomUUID();
    if (!this.profiles.length) this.profiles.push({ id: this.activeId, name: new URL(settings.baseUrl).hostname.replace(/^api\./, ""), baseUrl: settings.baseUrl, model: settings.model, reasoningEffort: settings.reasoningEffort });
    await this.saveCurrent(settings, key);
  }
  summaries() { return this.profiles.map(({ reasoningEffort: _, ...profile }) => ({ ...profile, hasApiKey: !!this.keys[profile.id] })); }
  connection(id: string) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new Error("Provider no longer exists. Refresh settings.");
    return { ...profile, key: this.keys[id] || "" };
  }
  async saveCurrent(settings: Settings, key: string, name?: string) {
    const current = this.connection(this.activeId);
    const profile = profileSchema.parse({ ...current, name: name ?? current.name, baseUrl: settings.baseUrl, model: settings.model, reasoningEffort: settings.reasoningEffort });
    const profiles = this.profiles.map(p => p.id === this.activeId ? profile : p);
    const keys = { ...this.keys, [this.activeId]: key };
    await this.persist(profiles, keys, this.activeId, settings, key);
  }
  async select(id: string, settings: Settings, model?: string) {
    const profile = this.connection(id);
    const next = { ...settings, baseUrl: profile.baseUrl, model: model ?? profile.model, reasoningEffort: model && model !== profile.model ? "default" : profile.reasoningEffort };
    const profiles = this.profiles.map(p => p.id === id ? { ...p, model: next.model, reasoningEffort: next.reasoningEffort } : p);
    await this.persist(profiles, this.keys, id, next, profile.key);
    return { settings: next, key: profile.key };
  }
  async add(input: unknown, settings: Settings) {
    if (this.profiles.length >= 20) throw new Error("Up to 20 providers can be saved.");
    const profile = profileSchema.parse({ ...(input as object), id: crypto.randomUUID(), model: "", reasoningEffort: "default" });
    const next = { ...settings, baseUrl: profile.baseUrl, model: "", reasoningEffort: "default" };
    await this.persist([...this.profiles, profile], { ...this.keys, [profile.id]: "" }, profile.id, next, "");
    return { settings: next, key: "" };
  }
  async remove(id: string, settings: Settings) {
    this.connection(id);
    if (this.profiles.length === 1) throw new Error("Keep at least one provider.");
    const profiles = this.profiles.filter(p => p.id !== id);
    const activeId = id === this.activeId ? profiles[0].id : this.activeId;
    const active = this.connection(activeId);
    const next = { ...settings, baseUrl: active.baseUrl, model: active.model, reasoningEffort: active.reasoningEffort };
    const keys = { ...this.keys }; delete keys[id];
    await this.persist(profiles, keys, activeId, next, active.key);
    return { settings: next, key: active.key };
  }
  private async persist(profiles: Profile[], keys: Record<string, string>, activeId: string, settings: Settings, key: string) {
    // One storage commit keeps the selected endpoint and its credential paired.
    await chrome.storage.local.set({ modelProviders: profiles, modelProviderKeys: keys, activeModelProviderId: activeId, settings, modelApiKey: key });
    this.profiles = profiles; this.keys = keys; this.activeId = activeId;
  }
}
