import type { Task, TaskDocument, TaskPriority, TaskStatus, TaskEvent } from "./types.js";

export const MAX_TASKS = 20_000;
const statuses = ["todo", "doing", "waiting", "done"];
const priorities = ["high", "medium", "low"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function date(value: unknown, optional = false): string | null {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string") throw new Error("日期格式无效");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) throw new Error("日期格式无效");
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) throw new Error("日期不存在");
  return new Date(value).toISOString();
}

export function parseDocument(raw: string): TaskDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("文件不是有效的 JSON，原数据已保留"); }
  const legacy = Array.isArray(parsed);
  if (!legacy && (!record(parsed) || parsed.version !== 2)) throw new Error("不支持的数据版本");
  const items: unknown = legacy ? parsed : (parsed as Record<string, unknown>).tasks;
  if (!Array.isArray(items) || items.length > MAX_TASKS) throw new Error("事项列表无效或超过 20000 条");
  const ids = new Set<string>();
  const tasks = items.map((value, index): Task => {
    try {
      if (!record(value) || typeof value.id !== "string" || !value.id || value.id.length > 200 || ids.has(value.id)) throw new Error("事项编号缺失或重复");
      ids.add(value.id);
      if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) throw new Error("名称应为 1–200 字");
      if (!statuses.includes(value.status as string) || !priorities.includes(value.priority as string)) throw new Error("状态或优先级无效");
      if (typeof value.note !== "string" || value.note.length > 20_000) throw new Error("备注无效或过长");
      const createdAt = date(value.createdAt)!;
      const status = value.status as TaskStatus;
      const completedAt = date(value.completedAt, true);
      if (status === "done" && !completedAt) throw new Error("已完成事项缺少完成时间");
      const history: TaskEvent[] = [];
      if (value.history !== undefined) {
        if (!Array.isArray(value.history)) throw new Error("状态记录无效");
        for (const event of value.history) {
          if (!record(event) || !statuses.includes(event.from as string) || !statuses.includes(event.to as string)) throw new Error("状态记录无效");
          history.push({ at: date(event.at)!, from: event.from as TaskStatus, to: event.to as TaskStatus });
        }
      }
      return {
        id: value.id, title: value.title.trim(), status, priority: value.priority as TaskPriority,
        note: value.note, createdAt, startedAt: date(value.startedAt, true), dueAt: date(value.dueAt, true),
        completedAt: status === "done" ? completedAt : null,
        updatedAt: date(value.updatedAt ?? completedAt ?? createdAt)!,
        waitingSince: status === "waiting" ? date(value.waitingSince, true) : null,
        deletedAt: date(value.deletedAt, true), history,
      };
    } catch (error) { throw new Error(`第 ${index + 1} 条事项：${(error as Error).message}`); }
  });
  return { version: 2, tasks };
}

export function changeStatus(task: Task, status: TaskStatus, at: string): Task {
  if (task.status === status) return task;
  return {
    ...task, status, updatedAt: at,
    startedAt: status === "doing" || status === "waiting" ? task.startedAt ?? at : task.startedAt,
    waitingSince: status === "waiting" ? at : null,
    completedAt: status === "done" ? at : null,
    history: [...task.history, { at, from: task.status, to: status }],
  };
}

export function mergeTasks(current: Task[], incoming: Task[]): Task[] {
  const tasks = new Map(current.map(task => [task.id, task]));
  // Import adds missing records; existing local records always win.
  for (const task of incoming) if (!tasks.has(task.id)) tasks.set(task.id, task);
  if (tasks.size > MAX_TASKS) throw new Error("合并后超过 20000 条事项");
  return [...tasks.values()];
}

export function sortTasks(tasks: Task[], completed = false): Task[] {
  const rank = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => completed
    ? (b.completedAt ?? b.deletedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.deletedAt ?? a.updatedAt)
    : rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
}

export function validateTimes(startedAt: string | null, dueAt: string | null, now: string, completedAt: string | null = null): string | null {
  if (startedAt && Date.parse(startedAt) > Date.parse(now)) return "实际开始时间不能晚于现在";
  if (startedAt && dueAt && Date.parse(dueAt) < Date.parse(startedAt)) return "预计完成时间不能早于开始时间";
  if (startedAt && completedAt && Date.parse(startedAt) > Date.parse(completedAt)) return "开始时间不能晚于实际完成时间";
  return null;
}
