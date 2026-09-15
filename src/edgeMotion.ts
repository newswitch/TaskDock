export type Edge = "left" | "right" | "top" | "bottom";
export type MotionRequest = { id: number; phase: "show" | "hide" | "reset" | "park"; edge: Edge };
export const SHOW_MS = 260;
export const HIDE_MS = 190;

const tucked: Record<Edge, string> = {
  right: "translate3d(100%, 0, 0)", left: "translate3d(-100%, 0, 0)",
  top: "translate3d(0, -100%, 0)", bottom: "translate3d(0, 100%, 0)",
};
const rest = { transform: "translate3d(0, 0, 0)" };

// Keep this independent of React so an animation never re-renders the task list.
export function createEdgeMotion(root: HTMLElement, complete: (id: number) => void,
  reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let latest = -1;
  let animation: Animation | undefined;
  let parked = false;
  let disposed = false;

  function clean() {
    const previous = animation;
    animation = undefined;
    previous?.cancel();
    root.style.removeProperty("will-change");
    delete root.dataset.edgeMotion;
    delete root.dataset.edge;
  }
  function settle(hidden: boolean) {
    parked = hidden;
    root.style.visibility = hidden ? "hidden" : "";
    clean();
  }

  return {
    get hiding() { return root.dataset.edgeMotion === "hide"; },
    handle(request: MotionRequest) {
      if (disposed || request.id < latest) return;
      if (request.id === latest && (request.phase === "show" || request.phase === "hide")) return;
      latest = request.id;
      if (request.phase === "reset" || request.phase === "park") {
        settle(request.phase === "park");
        return;
      }
      // Read the in-flight frame before cancellation for a continuous reversal.
      const current = animation ? getComputedStyle(root) : undefined;
      const start = current ? { transform: current.transform }
        : parked ? { transform: tucked[request.edge] } : rest;
      clean();
      const hidden = request.phase === "hide";
      if (reducedMotion() || typeof root.animate !== "function") {
        settle(hidden);
        complete(request.id);
        return;
      }
      root.style.visibility = "";
      root.style.willChange = "transform";
      root.dataset.edgeMotion = request.phase;
      root.dataset.edge = request.edge;
      const finish = hidden ? { transform: tucked[request.edge] } : rest;
      try {
        const running = root.animate([start, finish], {
          duration: hidden ? HIDE_MS : SHOW_MS,
          easing: hidden ? "cubic-bezier(.55, 0, 1, .45)" : "cubic-bezier(.16, 1, .3, 1)",
          fill: "both",
        });
        animation = running;
        void running.finished.then(() => {
          if (animation !== running || request.id !== latest || disposed) return;
          // Park before asking native code to hide; showing the native window
          // again therefore cannot flash the old full-size panel for one frame.
          settle(hidden);
          complete(request.id);
        }).catch(() => { /* Replaced by a newer motion or disposed. */ });
      } catch {
        settle(hidden);
        complete(request.id);
      }
    },
    dispose() { disposed = true; settle(false); },
  };
}
