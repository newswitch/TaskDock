export type TaskStatus = "todo" | "doing" | "waiting" | "done";

export type TaskPriority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  note: string;
  createdAt: string;
  startedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待处理",
  doing: "处理中",
  waiting: "等待他人",
  done: "已完成",
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const OPEN_STATUSES: TaskStatus[] = ["todo", "doing", "waiting"];
