import { useEffect, useRef, useState, type FocusEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createEdgeMotion, type MotionRequest } from "./edgeMotion";

const editable = (target: EventTarget | null) => target instanceof HTMLInputElement
  || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

export function useEdgeHide(blocked: boolean, onError: (message: string) => void) {
  const [pinned, setPinned] = useState(false);
  const [pinReady, setPinReady] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const changing = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    const root = document.getElementById("root")!;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const motion = createEdgeMotion(root, id => {
      void invoke("complete_edge_motion", { id }).catch(error => onError(`窗口过渡未完成：${String(error)}`));
    });
    const returnDuringHide = () => {
      if (motion.hiding) void invoke("reveal_edge_window").catch(error => onError(String(error)));
    };
    root.addEventListener("pointerenter", returnDuringHide);
    void listen<MotionRequest>("edge-motion", event => motion.handle(event.payload)).then(async stop => {
      if (cancelled) { stop(); return; }
      unlisten = stop;
      await invoke("set_edge_motion_ready", { ready: true });
    }).catch(error => { if (!cancelled) onError(`窗口动效暂时不可用：${String(error)}`); });
    return () => {
      cancelled = true;
      unlisten?.();
      root.removeEventListener("pointerenter", returnDuringHide);
      motion.dispose();
      void invoke("set_edge_motion_ready", { ready: false }).catch(() => {});
    };
  }, [onError]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<boolean>("get_window_pinned").then(value => {
      if (!cancelled) { setPinned(value); setPinReady(true); }
    }).catch(error => { if (!cancelled) onError(`无法读取图钉设置：${String(error)}`); });
    return () => { cancelled = true; };
  }, [onError]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_edge_interaction", { blocked, editingInput })
      .catch(error => onError(`靠边收起暂时不可用：${String(error)}`));
  }, [blocked, editingInput, onError]);

  useEffect(() => () => {
    if (isTauri()) void invoke("set_edge_interaction", { blocked: true, editingInput: false }).catch(() => {});
  }, []);

  async function togglePin() {
    if (!pinReady || changing.current) return;
    changing.current = true; setPinBusy(true);
    try { setPinned(await invoke<boolean>("set_window_pinned", { pinned: !pinned })); }
    catch (error) { onError(`无法保存图钉设置：${String(error)}`); }
    finally { changing.current = false; setPinBusy(false); }
  }

  return { pinned, pinReady, pinBusy, togglePin,
    onFocusCapture: (event: FocusEvent) => setEditingInput(editable(event.target)),
    onBlurCapture: (event: FocusEvent) => setEditingInput(editable(event.relatedTarget)),
  };
}
