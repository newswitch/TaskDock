import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Task } from "./types.js";
import { parseDocument } from "./tasks.js";

export const STORAGE_KEY = "taskdock.document.v2";
export const LEGACY_KEY = "taskdock.tasks.v1";
export interface Snapshot { payload: string | null; revision: number }
export interface Backup { id: number; createdAt: string }
export interface Backend {
  read(): Promise<Snapshot>;
  write(payload: string, revision: number): Promise<number>;
  backups(): Promise<Backup[]>;
  readBackup(id: number): Promise<string>;
}

export function browserBackend(storage: Storage): Backend {
  let baseline: string | null = null;
  let revision = 0;
  return {
    async read() {
      baseline = storage.getItem(STORAGE_KEY);
      return { payload: baseline, revision };
    },
    async write(payload, expected) {
      if (expected !== revision || storage.getItem(STORAGE_KEY) !== baseline) throw new Error("数据已在另一窗口更新，请重新加载后再操作");
      if (payload === baseline) return revision;
      if (baseline) {
        let valid = false;
        try { parseDocument(baseline); valid = true; } catch { /* preserve the known-good backup */ }
        if (valid) storage.setItem(`${STORAGE_KEY}.backup`, baseline);
      }
      storage.setItem(STORAGE_KEY, payload);
      baseline = payload;
      return ++revision;
    },
    async backups() { return storage.getItem(`${STORAGE_KEY}.backup`) ? [{ id: 1, createdAt: "上一次保存" }] : []; },
    async readBackup() {
      const raw = storage.getItem(`${STORAGE_KEY}.backup`);
      if (!raw) throw new Error("没有可用备份");
      return raw;
    },
  };
}

export const nativeBackend: Backend = {
  read: () => invoke("read_document"),
  write: (payload, revision) => invoke("write_document", { payload, expectedRevision: revision }),
  backups: () => invoke("list_backups"),
  readBackup: (id) => invoke("read_backup", { id }),
};

export class TaskRepository {
  private revision: number | null = null;
  private loading: Promise<{ tasks: Task[]; migrated: boolean }> | null = null;
  constructor(readonly backend: Backend, private readonly readLegacy: () => string | null) {}
  load(): Promise<{ tasks: Task[]; migrated: boolean }> {
    return this.loading ??= this.loadOnce().finally(() => { this.loading = null; });
  }
  private async loadOnce(): Promise<{ tasks: Task[]; migrated: boolean }> {
    const snapshot = await this.backend.read();
    this.revision = snapshot.revision;
    if (snapshot.payload !== null) return { tasks: parseDocument(snapshot.payload).tasks, migrated: false };
    const legacy = this.readLegacy();
    if (legacy !== null) {
      const document = parseDocument(legacy);
      // Keep the legacy key intact. Migration completes only after durable save.
      this.revision = await this.backend.write(JSON.stringify(document), this.revision);
      return { tasks: document.tasks, migrated: true };
    }
    return { tasks: [], migrated: false };
  }
  async save(tasks: Task[]): Promise<void> {
    if (this.revision === null) throw new Error("存储尚未就绪，请先重新加载");
    const document = parseDocument(JSON.stringify({ version: 2, tasks }));
    this.revision = await this.backend.write(JSON.stringify(document), this.revision);
  }
}

let repository: TaskRepository | undefined;
export function getRepository(): TaskRepository {
  return repository ??= new TaskRepository(isTauri() ? nativeBackend : browserBackend(localStorage), () => localStorage.getItem(LEGACY_KEY));
}
export function createId(): string { return crypto.randomUUID(); }
