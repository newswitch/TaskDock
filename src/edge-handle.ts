import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./EdgeHandle.css";

// This tiny window needs neither React nor the task repository.
type Edge = "left" | "right" | "top" | "bottom";
const button = document.getElementById("edge-peek") as HTMLButtonElement;
let revealing = false;
function setEdge(edge: Edge) {
  button.className = `edge-peek side-${edge}`;
}
async function reveal() {
  if (revealing) return;
  revealing = true;
  try { await invoke("reveal_edge_window"); button.title = "鼠标移到这里展开 TaskDock"; }
  catch (error) { button.title = String(error); }
  finally { revealing = false; }
}
button.addEventListener("pointerenter", () => void reveal());
button.addEventListener("click", () => void reveal());
void listen<Edge>("edge-handle-side", event => setEdge(event.payload))
  .then(async () => setEdge(await invoke<Edge>("edge_handle_ready")))
  .catch(error => { button.title = String(error); });
