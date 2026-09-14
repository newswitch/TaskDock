import { useEffect, useRef, type ReactNode } from "react";

export default function Dialog({ title, busy, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-header"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-btn" aria-label="关闭对话框" disabled={busy} onClick={onClose}>×</button></div>
    {children}
  </dialog>;
}
