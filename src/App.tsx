import { useEffect, useState } from "react";
import type { Task, TaskPriority, TaskStatus } from "./types";
import { OPEN_STATUSES, PRIORITY_LABEL, STATUS_LABEL } from "./types";
import { createId, loadTasks, saveTasks } from "./storage";
import { formatDateTime, formatDuration, nowIso } from "./time";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import "./App.css";

type Draft = {
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  note: string;
  startedAt: string;
  dueAt: string;
};

const emptyDraft = (): Draft => ({
  title: "",
  status: "todo",
  priority: "medium",
  note: "",
  startedAt: "",
  dueAt: "",
});

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks());
  const [now, setNow] = useState(() => new Date());
  const [showComposer, setShowComposer] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [autostartOn, setAutostartOn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    isEnabled()
      .then(setAutostartOn)
      .catch(() => setAutostartOn(false));
  }, []);

  const openTasks = tasks
    .filter((t) => OPEN_STATUSES.includes(t.status))
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 } as const;
      if (rank[a.priority] !== rank[b.priority]) {
        return rank[a.priority] - rank[b.priority];
      }
      const aStart = a.startedAt ?? a.createdAt;
      const bStart = b.startedAt ?? b.createdAt;
      return aStart.localeCompare(bStart);
    });

  const doneTasks = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  async function startDrag() {
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // ignore in browser preview
    }
  }

  async function hideWindow() {
    try {
      await getCurrentWindow().hide();
    } catch {
      // ignore
    }
  }

  async function toggleAutostart() {
    try {
      if (autostartOn) {
        await disable();
        setAutostartOn(false);
      } else {
        await enable();
        setAutostartOn(true);
      }
    } catch {
      // ignore when not in Tauri
    }
  }

  function openCreate() {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowComposer(true);
  }

  function openEdit(task: Task) {
    setEditingId(task.id);
    setDraft({
      title: task.title,
      status: task.status === "done" ? "todo" : task.status,
      priority: task.priority,
      note: task.note,
      startedAt: toLocalInputValue(task.startedAt),
      dueAt: toLocalInputValue(task.dueAt),
    });
    setShowComposer(true);
  }

  function submitDraft() {
    const title = draft.title.trim();
    if (!title) return;

    const startedAt = fromLocalInputValue(draft.startedAt);
    const dueAt = fromLocalInputValue(draft.dueAt);

    if (editingId) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === editingId
            ? {
                ...t,
                title,
                status: draft.status,
                priority: draft.priority,
                note: draft.note.trim(),
                startedAt:
                  draft.status === "todo"
                    ? startedAt
                    : startedAt ?? t.startedAt ?? nowIso(),
                dueAt,
                completedAt: null,
              }
            : t,
        ),
      );
    } else {
      const createdAt = nowIso();
      const task: Task = {
        id: createId(),
        title,
        status: draft.status,
        priority: draft.priority,
        note: draft.note.trim(),
        createdAt,
        startedAt:
          draft.status === "todo" ? startedAt : startedAt ?? createdAt,
        dueAt,
        completedAt: null,
      };
      setTasks((prev) => [task, ...prev]);
    }

    setShowComposer(false);
    setDraft(emptyDraft());
    setEditingId(null);
  }

  function setStatus(id: string, status: TaskStatus) {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (status === "done") {
          return { ...t, status, completedAt: nowIso() };
        }
        return {
          ...t,
          status,
          completedAt: null,
          startedAt:
            status === "todo"
              ? t.startedAt
              : t.startedAt ?? nowIso(),
        };
      }),
    );
  }

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function durationAnchor(task: Task): string {
    return task.startedAt ?? task.createdAt;
  }

  return (
    <div className="shell">
      <header className="titlebar" onMouseDown={startDrag}>
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <div className="brand-name">TaskDock</div>
            <div className="brand-sub">未解决事项 · {openTasks.length}</div>
          </div>
        </div>
        <div className="title-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="设置" onClick={() => setMenuOpen((v) => !v)}>
            ⋯
          </button>
          <button className="icon-btn" title="隐藏到托盘" onClick={hideWindow}>
            −
          </button>
        </div>
        {menuOpen && (
          <div className="menu" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => { setShowDone((v) => !v); setMenuOpen(false); }}>
              {showDone ? "隐藏已完成" : "查看已完成"}
            </button>
            <button onClick={() => { void toggleAutostart(); }}>
              开机自启：{autostartOn ? "开" : "关"}
            </button>
            <button onClick={() => setMenuOpen(false)}>关闭菜单</button>
          </div>
        )}
      </header>

      <main className="content">
        {openTasks.length === 0 ? (
          <div className="empty">
            <p>暂时没有未解决事项</p>
            <p className="muted">记下一件一直挂着的事，避免忙起来忘掉</p>
          </div>
        ) : (
          <ul className="task-list">
            {openTasks.map((task) => (
              <li key={task.id} className={`task status-${task.status} priority-${task.priority}`}>
                <button className="task-main" onClick={() => openEdit(task)}>
                  <div className="task-title-row">
                    <span className={`dot status-${task.status}`} />
                    <span className="task-title">{task.title}</span>
                  </div>
                  <div className="task-meta">
                    <span>{STATUS_LABEL[task.status]}</span>
                    <span>·</span>
                    <span>已持续 {formatDuration(durationAnchor(task), now)}</span>
                  </div>
                  <div className="task-times">
                    <span>开始 {formatDateTime(task.startedAt ?? task.createdAt)}</span>
                    {task.dueAt && <span>预计 {formatDateTime(task.dueAt)}</span>}
                    {task.priority !== "medium" && (
                      <span>优先级 {PRIORITY_LABEL[task.priority]}</span>
                    )}
                  </div>
                  {task.note && <p className="task-note">{task.note}</p>}
                </button>
                <div className="task-actions">
                  {task.status !== "todo" && (
                    <button onClick={() => setStatus(task.id, "todo")}>待处理</button>
                  )}
                  {task.status !== "doing" && (
                    <button onClick={() => setStatus(task.id, "doing")}>处理中</button>
                  )}
                  {task.status !== "waiting" && (
                    <button onClick={() => setStatus(task.id, "waiting")}>等待</button>
                  )}
                  <button className="done-btn" onClick={() => setStatus(task.id, "done")}>
                    完成
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {showDone && doneTasks.length > 0 && (
          <section className="done-section">
            <h2>已完成</h2>
            <ul className="task-list done">
              {doneTasks.slice(0, 20).map((task) => (
                <li key={task.id} className="task status-done">
                  <div className="task-main static">
                    <div className="task-title-row">
                      <span className="dot status-done" />
                      <span className="task-title">{task.title}</span>
                    </div>
                    <div className="task-meta">
                      <span>完成于 {formatDateTime(task.completedAt)}</span>
                    </div>
                  </div>
                  <div className="task-actions">
                    <button onClick={() => setStatus(task.id, "todo")}>重开</button>
                    <button className="danger" onClick={() => removeTask(task.id)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="footer">
        <button className="add-btn" onClick={openCreate}>
          ＋ 新增事项
        </button>
      </footer>

      {showComposer && (
        <div className="overlay">
          <div className="composer">
            <h2>{editingId ? "编辑事项" : "新增事项"}</h2>
            <label>
              事项名称
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="例如：GPU 监控接入"
              />
            </label>
            <div className="row-2">
              <label>
                状态
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, status: e.target.value as TaskStatus }))
                  }
                >
                  <option value="todo">待处理</option>
                  <option value="doing">处理中</option>
                  <option value="waiting">等待他人</option>
                </select>
              </label>
              <label>
                优先级
                <select
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, priority: e.target.value as TaskPriority }))
                  }
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
              </label>
            </div>
            <div className="row-2">
              <label>
                开始时间
                <input
                  type="datetime-local"
                  value={draft.startedAt}
                  onChange={(e) => setDraft((d) => ({ ...d, startedAt: e.target.value }))}
                />
              </label>
              <label>
                预计完成
                <input
                  type="datetime-local"
                  value={draft.dueAt}
                  onChange={(e) => setDraft((d) => ({ ...d, dueAt: e.target.value }))}
                />
              </label>
            </div>
            <label>
              备注
              <textarea
                rows={3}
                value={draft.note}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                placeholder="例如：等网络策略开通"
              />
            </label>
            <div className="composer-actions">
              {editingId && (
                <button className="danger" onClick={() => { removeTask(editingId); setShowComposer(false); }}>
                  删除
                </button>
              )}
              <div className="spacer" />
              <button onClick={() => setShowComposer(false)}>取消</button>
              <button className="primary" onClick={submitDraft}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
