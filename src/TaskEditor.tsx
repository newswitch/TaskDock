import { useState, type FormEvent } from "react";
import type { Task, TaskPriority, TaskStatus } from "./types";
import { changeStatus, parseDocument, validateTimes } from "./tasks";
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
  const [start, setStart] = useState(() => toLocalInputValue(task ? task.startedAt : new Date().toISOString()));
  const [startEdited, setStartEdited] = useState(false);
  const [due, setDue] = useState(toLocalInputValue(task?.dueAt ?? null));
  const [validation, setValidation] = useState("");
  const [progressText, setProgressText] = useState("");
  const [progressTime, setProgressTime] = useState(() => toLocalInputValue(new Date().toISOString()));
  const [progressTimeEdited, setProgressTimeEdited] = useState(false);
  const [progressLimit, setProgressLimit] = useState(20);
  const [progress, setProgress] = useState(task?.progress ?? []);
  const [editingProgress, setEditingProgress] = useState<string | null>(null);
  const [progressEdits, setProgressEdits] = useState<Record<string, { text: string; time: string }>>({});

  function editProgress(id: string) {
    const entry = progress.find(item => item.id === id)!;
    setProgressEdits(edits => ({ ...edits, [id]: edits[id] ?? { text: entry.text, time: toLocalInputValue(entry.at) } }));
    setEditingProgress(id);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setValidation("请填写事项名称"); return; }
    const at = new Date().toISOString();
    let startedAt = !task && !startEdited ? at : task && start === toLocalInputValue(task.startedAt) ? task.startedAt : fromLocalInputValue(start);
    const progressAt = progressTimeEdited ? fromLocalInputValue(progressTime) : at;
    if (progressText.trim() && (!progressAt || Date.parse(progressAt) > Date.parse(at))) {
      setValidation("请填写有效的进展时间，不能晚于现在"); return;
    }
    const dueAt = task && due === toLocalInputValue(task.dueAt) ? task.dueAt : fromLocalInputValue(due);
    if ((start && !startedAt) || (due && !dueAt)) { setValidation("请填写完整、有效的日期和时间"); return; }
    if (!startedAt && (status === "doing" || status === "waiting")) startedAt = at;
    const timeError = validateTimes(startedAt, dueAt, at, status === "done" ? task?.completedAt ?? at : null);
    if (timeError) { setValidation(timeError); return; }
    const revisedProgress = progress.map(entry => {
      const edit = progressEdits[entry.id];
      return edit ? { ...entry, text: edit.text.trim(), at: edit.time === toLocalInputValue(entry.at) ? entry.at : fromLocalInputValue(edit.time) ?? "" } : entry;
    });
    if (revisedProgress.some(entry => progressEdits[entry.id] && (!entry.at || Date.parse(entry.at) > Date.parse(at) || !entry.text))) {
      setValidation("进展内容不能为空，时间须有效且不晚于现在"); return;
    }
    const base: Task = task ?? {
      id: createId(), title: "", status: "todo", priority: "medium", note: "", createdAt: at,
      startedAt: null, dueAt: null, completedAt: null, waitingSince: null, updatedAt: at, deletedAt: null, history: [],
      goal: null, progress: [],
    };
    const next: Task = { ...changeStatus(base, status, at), title: title.trim(), priority, note: note.trim(), startedAt, dueAt, updatedAt: at,
      progress: progressText.trim() ? [...revisedProgress, { id: createId(), at: progressAt!, text: progressText.trim() }] : revisedProgress,
    };
    let validated: Task;
    try { validated = parseDocument(JSON.stringify({ version: 3, tasks: [next] })).tasks[0]; }
    catch (e) { setValidation(e instanceof Error ? e.message : String(e)); return; }
    setValidation("");
    if (await onSave(validated)) onClose();
  }

  return <Dialog title={task ? "事项详情" : "新增事项"} busy={busy} onClose={onClose}>
    <form className="composer" onSubmit={submit}>
      {(validation || error) && <p className="error" role="alert">{validation || error}</p>}
      <label>事项名称<input data-autofocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="记下一件还没解决的事" /></label>
      <div className="row-2">
        <label>状态<select value={status} onChange={e => setStatus(e.target.value as TaskStatus)}>
          <option value="todo">待处理</option><option value="doing">处理中</option><option value="waiting">等待他人</option>
          <option value="done">已完成</option>
        </select></label>
        <label>优先级<select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      </div>
      <section className="progress-section" aria-label="任务进展">
        <label>记录新进展<textarea rows={2} maxLength={2000} disabled={busy} value={progressText} onChange={e => setProgressText(e.target.value)} /></label>
        {progressText.trim() && <div className="entry-time">
          <label>进展时间<input type="datetime-local" required disabled={busy} value={progressTime} onChange={e => { setProgressTime(e.target.value); setProgressTimeEdited(true); }} /></label>
          <button type="button" className="text-btn" disabled={busy} onClick={() => { setProgressTime(toLocalInputValue(new Date().toISOString())); setProgressTimeEdited(false); }}>使用当前时间</button>
        </div>}
        {progress.length > 0 && <details className="progress-history">
          <summary>进展记录（{progress.length}）</summary>
          <ol>{[...progress].reverse().slice(0, progressLimit).map(entry => <li key={entry.id}>
            <div className="progress-entry-header">
              <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
              <div className="progress-entry-actions">
                <button type="button" disabled={busy} aria-expanded={editingProgress === entry.id} onClick={() => editingProgress === entry.id ? setEditingProgress(null) : editProgress(entry.id)}>{editingProgress === entry.id ? "收起" : "编辑"}</button>
                <button type="button" disabled={busy} onClick={() => { setProgress(items => items.filter(item => item.id !== entry.id)); if (editingProgress === entry.id) setEditingProgress(null); }}>删除</button>
              </div>
            </div>
            {editingProgress === entry.id ? <div className="progress-entry-editor">
              <label>进展内容<textarea rows={2} maxLength={2000} disabled={busy} value={progressEdits[entry.id].text} onChange={e => { const text = e.target.value; setProgressEdits(edits => ({ ...edits, [entry.id]: { ...edits[entry.id], text } })); }} /></label>
              <label>进展时间<input type="datetime-local" disabled={busy} value={progressEdits[entry.id].time} onChange={e => { const time = e.target.value; setProgressEdits(edits => ({ ...edits, [entry.id]: { ...edits[entry.id], time } })); }} /></label>
            </div> : <p>{progressEdits[entry.id]?.text ?? entry.text}</p>}
          </li>)}</ol>
          {progress.length > progressLimit && <button type="button" className="text-btn" onClick={() => setProgressLimit(progressLimit + 20)}>查看更多进展</button>}
        </details>}
      </section>
      <label>实际开始时间<input type="datetime-local" value={start} onChange={e => { setStart(e.target.value); setStartEdited(true); }} /></label>
      {!task && <p className="field-hint">默认使用保存时的当前时间；可修改，未开始也可清空。</p>}
      <label>预计完成时间<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
      <label>备注<textarea rows={3} maxLength={20000} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：等网络策略开通" /></label>
      {task && <div className="detail-times">
        <p>创建：{formatDateTime(task.createdAt)}</p>
        {task.waitingSince && <p>本次等待始于：{formatDateTime(task.waitingSince)}</p>}
        {task.completedAt && <p>实际完成：{formatDateTime(task.completedAt)}</p>}
      </div>}
      <div className="composer-actions">
        {task && <button type="button" className="danger" disabled={busy} onClick={() => void onDelete(task)}>移入回收站</button>}
        <span className="spacer" /><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
      </div>
    </form>
  </Dialog>;
}
