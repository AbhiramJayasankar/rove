import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import type { RunRecord } from "../shared/types";
describe("durable run journal", () => {
  it("retries a transient Windows atomic-replacement lock without deleting data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-"));
    const rename = vi.spyOn(fs, "renameSync");
    rename.mockImplementationOnce(() => {
      throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
    });
    try {
      const store = new Store(dir);
      expect(store.token).toHaveLength(64);
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      rename.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("appends events once, preserves pairing, and marks interrupted runs on restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-"));
    try {
      const store = new Store(dir);
      const token = store.token;
      const run: RunRecord = {
        id: "example",
        prompt: "Read the page",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [
          {
            id: 1,
            time: new Date().toISOString(),
            type: "status",
            data: { status: "running" },
          },
        ],
      };
      store.saveRun(structuredClone(run));
      run.events.push({
        id: 2,
        time: new Date().toISOString(),
        type: "tool_result",
        data: { result: "Page title" },
      });
      store.saveRun(structuredClone(run));
      store.saveRun(structuredClone(run));
      expect(
        fs
          .readFileSync(path.join(dir, "runs", "example.events.jsonl"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(2);
      const recovered = new Store(dir);
      expect(recovered.token).toBe(token);
      expect(recovered.getRun("example")?.status).toBe("failed");
      expect(recovered.getRun("example")?.events).toHaveLength(3);
      const reloaded = new Store(dir);
      expect(reloaded.getRun("example")?.events).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
