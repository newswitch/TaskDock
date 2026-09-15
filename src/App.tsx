import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { Task, TaskStatus } from "./types";
import { PRIORITY_LABEL, STATUS_LABEL } from "./types";
import { getRepository, type Backup } from "./storage";
import { changeStatus, mergeTasks, parseDocument, sortTasks, taskSummary } from "./tasks";
import { formatDateTime, formatDuration, nowIso } from "./time";
import TaskEditor from "./TaskEditor";
import Dialog from "./Dialog";
import { useEdgeHide } from "./useEdgeHide";
import "./App.css";

type View = "open" | "done" | "trash";
type ImportPreview = { tasks: Task[]; source: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const OPACITY_KEY = "taskdock.panel-opacity.v1";
function readPanelOpacity(): number {
  try {
    const value = Number(localStorage.getItem(OPACITY_KEY));
    if (Number.isInteger(value) && value >= 45 && value <= 96) return value;
  } catch { /* Use the default when appearance preferences are unavailable. */ }
  return 82;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const toastSequence = useRef(0);
  const [dataPath, setDataPath] = useState<string | null>(null);
  function setMessage(text: string) {
    setToast(text ? { text, id: ++toastSequence.current } : null);
  }
  const [view, setView] = useState<View>("open");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(50);
  const [now, setNow] = useState(new Date());
  const [editor, setEditor] = useState<{ task: Task | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpacity, setPanelOpacity] = useState(readPanelOpacity);
  const menuRef = useRef<HTMLDivElement>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const desktop = isTauri();
  const hasRunningClock = tasks.some(task => !task.deletedAt && task.status !== "done");
  const edgeHide = useEdgeHide(!ready || busy || menuOpen || !!editor || !!backups || !!preview || !!error || dataPath !== null, setError);

  useEffect(() => {
    let cancelled = false;
    getRepository().load().then(result => {
      if (cancelled) return;
      setTasks(result.tasks); setReady(true);
      if (result.migrated) setMessage("已迁移旧版事项，原始数据仍保留");
    }).catch(e => { if (!cancelled) setError(`读取失败：${errorText(e)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    function refresh() {
      window.clearTimeout(timer);
      if (!document.hidden) {
        const current = new Date();
        setNow(current);
        const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
        timer = window.setTimeout(refresh, hasRunningClock ? 60000 : tomorrow.getTime() - current.getTime() + 100);
      }
    }
    refresh(); document.addEventListener("visibilitychange", refresh);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [hasRunningClock]);

  useEffect(() => {
    if (desktop) isEnabled().then(setAutostart).catch(e => setError(`无法读取开机自启状态：${errorText(e)}`));
  }, [desktop]);
  useEffect(() => { setLimit(50); }, [view, query, filter]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(errorText(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function commit(next: Task[], success = "已保存"): Promise<boolean> {
    if (lock.current) return false;
    let saved = false;
    await perform(async () => {
      await getRepository().save(next);
      setTasks(next); setReady(true); setNow(new Date());
      setMessage(success === "已保存" ? "保存成功" : success);
      saved = true;
    });
    return saved;
  }
  async function reload() {
    await perform(async () => {
      const result = await getRepository().load(); setTasks(result.tasks); setReady(true); setMessage("已重新加载");
    });
  }
  async function setStatus(task: Task, status: TaskStatus) {
    await commit(tasks.map(t => t.id === task.id ? changeStatus(t, status, nowIso()) : t));
  }
  async function trash(task: Task) {
    if (await commit(tasks.map(t => t.id === task.id ? { ...t, deletedAt: nowIso(), updatedAt: nowIso() } : t), "已移入回收站，可随时恢复")) setEditor(null);
  }
  function edit(task: Task | null) { setError(""); setMenuOpen(false); setEditor({ task }); }
  async function windowAction(action: "hide" | "dock") {
    await perform(async () => {
      if (action === "hide") await invoke("hide_to_tray"); else await invoke("dock_window");
      setMenuOpen(false);
    });
  }
  function inspectImport(raw: string, source: string) {
    const document = parseDocument(raw.replace(/^\uFEFF/, ""));
    setPreview({ tasks: document.tasks, source }); setBackups(null); setMenuOpen(false);
    setImportMode(ready ? "merge" : "replace"); setReplaceConfirmed(false); setError("");
  }
  async function chooseImport() {
    setMenuOpen(false);
    if (!desktop) { fileInput.current?.click(); return; }
    await perform(async () => { const raw = await invoke<string | null>("import_file"); if (raw !== null) inspectImport(raw, "所选备份文件"); });
  }
  async function exportBackup() {
    await perform(async () => {
      const payload = JSON.stringify({ version: 3, tasks }, null, 2);
      if (desktop) { if (await invoke<boolean>("export_file", { payload })) setMessage("备份已导出"); }
      else {
        const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `TaskDock-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
        setMessage("已生成备份下载");
      }
      setMenuOpen(false);
    });
  }
  async function showBackups() {
    await perform(async () => { setBackups(await getRepository().backend.backups()); setMenuOpen(false); });
  }
  async function importTasks() {
    if (!preview || (importMode === "replace" && !replaceConfirmed)) return;
    try {
      const next = importMode === "merge" ? mergeTasks(tasks, preview.tasks) : preview.tasks;
      if (await commit(next, importMode === "merge" ? "已合并备份，现有事项保持原样" : "已恢复所选备份")) setPreview(null);
    } catch (e) { setError(errorText(e)); }
  }

  const active = tasks.filter(t => !t.deletedAt);
  const openCount = active.filter(t => t.status !== "done").length;
  const doneCount = active.length - openCount;
  const trashCount = tasks.length - active.length;
  const searched = tasks.filter(task => {
    if (view === "trash" ? !task.deletedAt : task.deletedAt || (view === "done" ? task.status !== "done" : task.status === "done")) return false;
    if (view === "open" && filter !== "all" && task.status !== filter) return false;
    return `${task.title}\n${task.note}\n${task.goal?.title ?? ""}\n${task.progress.map(entry => entry.text).join("\n")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  const visibleTasks = sortTasks(searched, view !== "open");

  return <div className="shell" style={{ "--panel-opacity": panelOpacity / 100 } as CSSProperties}
    onFocusCapture={edgeHide.onFocusCapture} onBlurCapture={edgeHide.onBlurCapture}>
    <header className="titlebar" onMouseDown={e => { if (desktop && e.button === 0) void getCurrentWindow().startDragging().catch(err => setError(errorText(err))); }}>
      <div className="brand"><span className="brand-mark" aria-hidden="true">&gt;_</span><div className="brand-name">taskdock<span className="brand-count" aria-label={`未解决事项 ${openCount} 条`} title={`未解决事项 ${openCount} 条`}>{openCount}</span></div></div>
      <div className="title-actions" onMouseDown={e => e.stopPropagation()}>
        {desktop && <button className="icon-btn pin-btn" aria-label="固定窗口" aria-pressed={edgeHide.pinned}
          title={edgeHide.pinned ? "已固定：靠边保持展开，点击取消固定" : "靠边自动收起，点击固定窗口"}
          disabled={!edgeHide.pinReady || edgeHide.pinBusy} onClick={() => void edgeHide.togglePin()}>
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v6" /></svg>
        </button>}
        <button className="header-add-btn" title="新增事项" aria-label="新增事项" disabled={!ready || busy} onClick={() => edit(null)}>＋ 新增</button>
        <div ref={menuRef}>
          <button className="icon-btn" aria-label="设置" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>⋯</button>
          {menuOpen && <div className="menu">
            <div className="appearance-setting">
              <label htmlFor="panel-opacity">背景浓度 <output htmlFor="panel-opacity">{panelOpacity}%</output></label>
              <input id="panel-opacity" type="range" min="45" max="96" step="1" value={panelOpacity} aria-valuetext={`${panelOpacity}%`} onChange={event => {
                const value = Number(event.target.value); setPanelOpacity(value);
                try { localStorage.setItem(OPACITY_KEY, String(value)); }
                catch { setError("外观已调整，但设置暂时无法保存，重启后会恢复默认。"); }
              }} />
              <p>调淡可透出背景，调深让文字更清晰</p>
            </div>
            {desktop && <><button disabled={busy} onClick={() => void windowAction("dock")}>停靠右上角</button>
              <button disabled={busy} onClick={() => void perform(async () => {
                const current = await isEnabled(); if (current) await disable(); else await enable();
                setAutostart(await isEnabled()); setMessage(current ? "已关闭开机自启" : "已开启开机自启");
              })}>开机自启：{autostart === null ? "重试读取" : autostart ? "开" : "关"}</button></>}
            <button disabled={busy || !ready} onClick={() => void exportBackup()}>导出备份</button>
            <button disabled={busy} onClick={() => void chooseImport()}>导入备份</button>
            <button disabled={busy} onClick={() => void showBackups()}>恢复保存版本</button>
            <button disabled={busy} onClick={() => void reload()}>重新加载数据</button>
            {desktop && <button disabled={busy} onClick={() => void perform(async () => { setDataPath(await invoke<string>("data_path")); setMenuOpen(false); })}>查看数据位置</button>}
            <span className="menu-version">TaskDock 1.0 · {desktop ? "本机保存" : "浏览器预览"}</span>
          </div>}
        </div>
        {desktop && <button className="icon-btn" aria-label="隐藏到托盘" disabled={busy} onClick={() => void windowAction("hide")}>−</button>}
      </div>
    </header>
    <div className="tabs" role="tablist" aria-label="事项视图">
      {([["open", "未解决", openCount], ["done", "已完成", doneCount], ["trash", "回收站", trashCount]] as const).map(([key, label, count]) =>
        <button role="tab" aria-selected={view === key} key={key} onClick={() => setView(key)}>{label} <span>{count}</span></button>)}
    </div>
    <div className="filters"><input type="search" aria-label="搜索事项" placeholder="搜索名称或备注" value={query} onChange={e => setQuery(e.target.value)} />
      {view === "open" && <select aria-label="筛选状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="todo">待处理</option><option value="doing">处理中</option><option value="waiting">等待他人</option></select>}
    </div>
    {error && <div className="notice error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError("")}>×</button></div>}
    <div className="save-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && <div key={toast.id} className="save-toast"><span aria-hidden="true">✓</span><span>{toast.text}</span></div>}
    </div>
    <main className="content" aria-busy={loading || busy}>
      {loading ? <div className="empty">正在读取事项…</div> : !ready ? <div className="empty"><p>暂时无法读取事项</p><p className="muted">原始数据已保留，请重试或选择备份恢复。</p><button disabled={busy} className="text-btn" onClick={() => void reload()}>重试读取</button><button disabled={busy} className="text-btn" onClick={() => void showBackups()}>查看保存版本</button><button disabled={busy} className="text-btn" onClick={() => void chooseImport()}>导入备份</button></div> : visibleTasks.length === 0 ?
        <div className="empty"><div className="empty-prompt" aria-hidden="true">{view === "done" ? "[✓]" : view === "trash" ? "[ ]" : ">_"}</div><p>{query || filter !== "all" && view === "open" ? "没有匹配的事项" : view === "open" ? "暂时没有未解决事项" : view === "done" ? "还没有已完成事项" : "回收站是空的"}</p><p className="muted">{view === "open" ? "记下来，忙起来也不会忘。" : view === "trash" ? "移入回收站的事项可以随时恢复。" : "完成的事项会保留时间和状态记录。"}</p></div> :
        <ul className="task-list">{visibleTasks.slice(0, limit).map(task => {
          const overdue = !task.deletedAt && task.status !== "done" && task.dueAt && Date.parse(task.dueAt) < now.getTime();
          const summary = taskSummary(task);
          return <li key={task.id} className={`task status-${task.status} priority-${task.priority}`}>
            <button className="task-main" disabled={view === "trash" || busy} onClick={() => edit(task)}>
              <div className="task-title-row"><span className="task-title" title={task.title}>{task.title}</span>{task.priority === "high" && <span className="priority-label">{PRIORITY_LABEL[task.priority]}</span>}</div>
              <div className="task-meta"><span className={`status-label status-${task.status}`}>{STATUS_LABEL[task.status]}</span><span className="task-duration">{task.status === "done" ? `历时 ${formatDuration(task.startedAt ?? task.createdAt, new Date(task.completedAt!))}` : task.status === "waiting" ? task.waitingSince ? `本次已等待 ${formatDuration(task.waitingSince, now)}` : "旧记录未记等待起点" : task.startedAt ? `已开始 ${formatDuration(task.startedAt, now)}` : `已创建 ${formatDuration(task.createdAt, now)}`}</span>{summary && <span className="task-note" title={summary}>{summary}</span>}</div>
              {(task.dueAt || task.deletedAt) && <div className="task-times">
                {task.dueAt && <span className={overdue ? "overdue" : ""}>{overdue ? "已超期 · 预计" : "预计"} {formatDateTime(task.dueAt)}</span>}
                {task.deletedAt && <span>移入回收站 {formatDateTime(task.deletedAt)}</span>}
              </div>}
            </button>
            <div className="task-actions">
              {view === "trash" ? <button disabled={busy} onClick={() => void commit(tasks.map(t => t.id === task.id ? { ...t, deletedAt: null, updatedAt: nowIso() } : t), "事项已恢复")}>恢复事项</button> : task.status === "done" ? <button disabled={busy} onClick={() => void setStatus(task, "todo")}>重开</button> :
                <button disabled={busy} title="将此事项标记为已完成" onClick={() => void setStatus(task, "done")}>完成</button>}
            </div>
          </li>;
        })}</ul>}
      {visibleTasks.length > limit && <button className="load-more" onClick={() => setLimit(limit + 50)}>加载更多（还有 {visibleTasks.length - limit} 条）</button>}
    </main>
    {desktop && (["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const).map(direction => <div aria-hidden="true" key={direction} className={`resize-handle resize-${direction}`} onPointerDown={event => { if (event.button === 0) void getCurrentWindow().startResizeDragging(direction).catch(e => setError(errorText(e))); }} />)}
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void perform(async () => { if (file.size > 50 * 1024 * 1024) throw new Error("文件不能超过 50 MB"); inspectImport(await file.text(), file.name); });
    }} />
    {editor && <TaskEditor task={editor.task} busy={busy} error={error} onClose={() => setEditor(null)} onDelete={trash} onSave={task => commit(editor.task ? tasks.map(t => t.id === task.id ? task : t) : [task, ...tasks])} />}
    {dataPath !== null && <Dialog title="数据位置" busy={busy} onClose={() => setDataPath(null)}><div className="panel-body data-path">{dataPath}</div></Dialog>}
    {backups && <Dialog title="恢复保存版本" busy={busy} onClose={() => setBackups(null)}><div className="panel-body">
      <p className="muted">{desktop ? "保留最近 20 个保存前的版本。" : "浏览器预览保留上一次保存。"}选择后可先查看数量，再决定恢复。</p>
      {error && <p className="error" role="alert">{error}</p>}
      {backups.length ? <ul className="backup-list">{backups.map(backup => <li key={backup.id}><button disabled={busy} onClick={() => void perform(async () => inspectImport(await getRepository().backend.readBackup(backup.id), `保存版本 #${backup.id}`))}>{backup.createdAt.includes("T") ? formatDateTime(backup.createdAt) : backup.createdAt}<span>查看 →</span></button></li>)}</ul> : <p>暂无保存版本。修改事项后会自动保留旧版本。</p>}
    </div></Dialog>}
    {preview && <Dialog title="导入备份" busy={busy} onClose={() => setPreview(null)}><div className="panel-body">
      <p className="import-source">{preview.source}</p><p>包含 {preview.tasks.filter(t => !t.deletedAt && t.status !== "done").length} 条未解决、{preview.tasks.filter(t => !t.deletedAt && t.status === "done").length} 条已完成、{preview.tasks.filter(t => t.deletedAt).length} 条回收站事项。</p>
      <label className="radio-option"><input type="radio" name="importMode" checked={importMode === "merge"} disabled={!ready || busy} onChange={() => setImportMode("merge")} /><span>合并：只新增缺少的事项，保留当前修改</span></label>
      <label className="radio-option"><input type="radio" name="importMode" checked={importMode === "replace"} disabled={busy} onChange={() => setImportMode("replace")} /><span>恢复：用这个版本替换当前全部事项</span></label>
      {importMode === "replace" && <label className="radio-option"><input type="checkbox" checked={replaceConfirmed} disabled={busy} onChange={e => setReplaceConfirmed(e.target.checked)} /><span>确认替换当前数据；当前有效版本会保留为自动备份。</span></label>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="composer-actions"><span className="spacer" /><button disabled={busy} onClick={() => setPreview(null)}>取消</button><button className="primary" disabled={busy || importMode === "replace" && !replaceConfirmed} onClick={() => void importTasks()}>{busy ? "导入中…" : "确认导入"}</button></div>
    </div></Dialog>}
  </div>;
}
