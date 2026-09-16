import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Drag = { source: string; target: string; after: boolean };

export function useTaskReorder(enabled: boolean, context: string, onDrop: (drag: Drag) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  useEffect(() => () => cancelRef.current?.(), [enabled, context]);

  function start(event: ReactPointerEvent<HTMLElement>, source: string) {
    if (!enabled || event.button !== 0 || !event.isPrimary) return;
    cancelRef.current?.();
    suppressClick.current = false;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    let x = startX, y = startY;
    let active = false, frame = 0;
    let current: Drag = { source, target: source, after: false };

    function finish(save: boolean) {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      element.removeEventListener("lostpointercapture", cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      cancelRef.current = null;
      setDrag(null);
      if (active && save) dropRef.current(current);
    }
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
    function tick() {
      const container = contentRef.current;
      if (!container) { cancel(); return; }
      const bounds = container.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right) {
        const speed = y < bounds.top + 32 ? -7 : y > bounds.bottom - 32 ? 7 : 0;
        container.scrollTop += speed;
        const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"));
        const row = rows.find(item => y < item.getBoundingClientRect().bottom) ?? rows[rows.length - 1];
        if (row) {
          const box = row.getBoundingClientRect();
          const next = { source, target: row.dataset.taskId!, after: y > box.top + box.height / 2 };
          if (next.target !== current.target || next.after !== current.after) { current = next; setDrag(next); }
        }
      }
      frame = requestAnimationFrame(tick);
    }
    function move(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      x = e.clientX; y = e.clientY;
      if (!active && Math.hypot(x - startX, y - startY) > 8) { cancel(); return; }
      if (active) e.preventDefault();
    }
    function up(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      const bounds = contentRef.current?.getBoundingClientRect();
      finish(!!bounds && e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom);
    }
    const timer = window.setTimeout(() => {
      active = true;
      suppressClick.current = true;
      element.setPointerCapture(pointerId);
      setDrag(current);
      frame = requestAnimationFrame(tick);
    }, 450);
    cancelRef.current = cancel;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    element.addEventListener("lostpointercapture", cancel);
  }

  return { drag, contentRef, start, consumeClick: () => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  } };
}
