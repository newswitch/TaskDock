import { useState, type FormEvent } from "react";
import type { Task, TaskPriority, TaskStatus } from "./types";
import { STATUS_LABEL } from "./types";
import { changeStatus, validateTimes } from "./tasks";
import { createId } from "./storage";
import { formatDateTime, fromLocalInputValue, toLocalInputValue } from "./time";
import Dialog from "./Dialog";

export default function TaskEditor({ task, busy, error, onSave, onDelete, onClose }: {
  task: Task | null; busy: boolean; error: string; onSave: (task: Task) => Promise<boolean>;
  onDelete: (task: Task) => Promise<void>; onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "medium");
  const [note, setNote] = useState(task?.note ?? "");
  const [start, setStart] = useState(toLocalInputValue(task?.startedAt ?? null));
  const [due, setDue] = useState(toLocalInputValue(task?.dueAt ?? null));
  const [validation, setValidation] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setValidation("请填写事项名称"); return; }
    const at = new Date().toISOString();
    let startedAt = task && start === toLocalInputValue(task.startedAt) ? task.startedAt : fromLocalInputValue(start);
    const dueAt = task && due === toLocalInputValue(task.dueAt) ? task.dueAt : fromLocalInputValue(due);
    if ((start && !startedAt) || (due && !dueAt)) { setValidation("请填写完整、有效的日期和时间"); return; }
    if (!startedAt && (status === "doing" || status === "waiting")) startedAt = at;
    const timeError = validateTimes(startedAt, dueAt, at, status === "done" ? task?.completedAt ?? at : null);
    if (timeError) { setValidation(timeError); return; }
    const base: Task = task ?? {
      id: createId(), title: "", status: "todo", priority: "medium", note: "", createdAt: at,
      startedAt: null, dueAt: null, completedAt: null, waitingSince: null, updatedAt: at, deletedAt: null, history: [],
    };
    const next = { ...changeStatus(base, status, at), title: title.trim(), priority, note: note.trim(), startedAt, dueAt, updatedAt: at };
    setValidation("");
    if (await onSave(next)) onClose();
  }

  return <Dialog title={task ? "事项详情" : "新增事项"} busy={busy} onClose={onClose}>
    <form className="composer" onSubmit={submit}>
      {(validation || error) && <p className="error" role="alert">{validation || error}</p>}
      <label>事项名称<input data-autofocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="记下一件还没解决的事" /></label>
      <div className="row-2">
        <label>状态<select value={status} onChange={e => setStatus(e.target.value as TaskStatus)}>
          <option value="todo">待处理</option><option value="doing">处理中</option><option value="waiting">等待他人</option>
          {task && <option value="done">已完成</option>}
        </select></label>
        <label>优先级<select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      </div>
      <label>实际开始时间<input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></label>
      <p className="field-hint">可留空。进入处理中或等待他人时，自动记录首次开始时间。</p>
      <label>预计完成时间<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
      <label>备注<textarea rows={3} maxLength={20000} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：等网络策略开通" /></label>
      {task && <div className="detail-times">
        <p>创建：{formatDateTime(task.createdAt)}</p>
        {task.waitingSince && <p>本次等待始于：{formatDateTime(task.waitingSince)}</p>}
        {task.completedAt && <p>实际完成：{formatDateTime(task.completedAt)}</p>}
        {task.history.length > 0 && <details><summary>状态记录（{task.history.length}）</summary>
          <ol className="history">{[...task.history].reverse().map((event, index) => <li key={index}>{formatDateTime(event.at)}<br />{STATUS_LABEL[event.from]} → {STATUS_LABEL[event.to]}</li>)}</ol>
        </details>}
      </div>}
      <div className="composer-actions">
        {task && <button type="button" className="danger" disabled={busy} onClick={() => void onDelete(task)}>移入回收站</button>}
        <span className="spacer" /><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
      </div>
    </form>
  </Dialog>;
}
