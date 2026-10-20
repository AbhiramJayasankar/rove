import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { RunRecord, Settings } from "../shared/types";

export class Store {
  readonly dir: string;
  settings: Settings;
  token: string;
  private runs = new Map<string, RunRecord>();
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true, mode: 0o700 });
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...this.read("settings.json", {}),
    };
    this.token =
      this.read("pairing.json", { token: "" }).token ||
      randomBytes(32).toString("hex");
    this.write("pairing.json", { token: this.token });
    for (const filename of fs.readdirSync(path.join(dir, "runs"))) {
      if (!filename.endsWith(".json")) continue;
      const run = this.read(
        path.join("runs", filename),
        null,
      ) as RunRecord | null;
      if (!run || !Array.isArray(run.events) || !run.id) continue;
      const journal = path.join(dir, "runs", `${run.id}.events.jsonl`);
      if (!fs.existsSync(journal) && run.events.length)
        fs.appendFileSync(
          journal,
          run.events.map((event) => JSON.stringify(event) + "\n").join(""),
          { mode: 0o600 },
        );
      if (fs.existsSync(journal)) {
        run.events = fs
          .readFileSync(journal, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
      }
      if (run.events.at(-1)?.time) run.updatedAt = run.events.at(-1)!.time;
      if (run.status === "running" || run.status === "awaiting_approval") {
        run.status = "failed";
        run.updatedAt = new Date().toISOString();
        run.events.push({
          id: (run.events.at(-1)?.id || 0) + 1,
          time: run.updatedAt,
          type: "error",
          data: {
            message:
              "Server restarted. This run was interrupted; start a new task to continue.",
          },
        });
        const recovery = run.events.at(-1)!;
        fs.appendFileSync(journal, `${JSON.stringify(recovery)}\n`, {
          mode: 0o600,
        });
        this.write(path.join("runs", `${run.id}.json`), { ...run, events: [] });
      }
      this.runs.set(run.id, run);
    }
  }
  private read(file: string, fallback: any): any {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8"));
    } catch {
      return fallback;
    }
  }
  private write(file: string, value: unknown) {
    const target = path.join(this.dir, file);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
    // Windows indexing/antivirus can briefly hold the destination without
    // FILE_SHARE_DELETE. Retry the atomic replacement, never delete the target.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(`${target}.tmp`, target);
        break;
      } catch (error) {
        if (
          attempt >= 8 ||
          !["EPERM", "EACCES", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(10 * 2 ** attempt, 160),
        );
      }
    }
  }
  saveSettings(settings: Settings) {
    this.write("settings.json", settings);
    this.settings = structuredClone(settings);
  }
  rotateToken() {
    this.token = randomBytes(32).toString("hex");
    this.write("pairing.json", { token: this.token });
    return this.token;
  }
  saveRun(run: RunRecord) {
    const previous = this.runs.get(run.id);
    const oldCount = previous?.events.length || 0;
    const events = run.events.slice(oldCount);
    if (events.length)
      fs.appendFileSync(
        path.join(this.dir, "runs", `${run.id}.events.jsonl`),
        events.map((event) => JSON.stringify(event) + "\n").join(""),
        { mode: 0o600 },
      );
    if (!previous || previous.status !== run.status)
      this.write(path.join("runs", `${run.id}.json`), { ...run, events: [] });
    this.runs.set(run.id, run);
  }
  getRun(id: string) {
    return this.runs.get(id);
  }
  listRuns() {
    return [...this.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
