import test from "node:test";
import assert from "node:assert/strict";
import { createEdgeMotion, SHOW_MS, HIDE_MS } from "../.test-build/edgeMotion.js";

function surface() {
  const animations = [];
  const root = {
    dataset: {}, style: { removeProperty(name) { if (name === "will-change") delete this.willChange; } },
    animate(frames, options) {
      let resolve, reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      const animation = { frames, options, finished, finish: resolve, cancel() { this.cancelled = true; reject(new Error("cancelled")); } };
      animations.push(animation);
      return animation;
    },
  };
  const completed = [];
  return { root, animations, completed, motion: createEdgeMotion(root, id => completed.push(id), () => false) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("hide parks before completion, reveal starts tucked, and idle keeps no animation layer", async () => {
  const { root, animations, completed, motion } = surface();
  motion.handle({ id: 1, phase: "hide", edge: "right" });
  assert.equal(animations[0].options.duration, HIDE_MS);
  animations[0].finish(); await flush();
  assert.equal(root.style.visibility, "hidden");
  assert.equal(root.style.willChange, undefined);
  assert.equal(root.dataset.edgeMotion, undefined);
  assert.deepEqual(completed, [1]);
  motion.handle({ id: 2, phase: "show", edge: "right" });
  assert.equal(animations[1].frames[0].transform, "translate3d(100%, 0, 0)");
  assert.equal(animations[1].options.duration, SHOW_MS);
  animations[1].finish(); await flush();
  assert.equal(root.style.visibility, "");
  assert.equal(root.style.willChange, undefined);
  assert.ok(animations.every(animation => animation.cancelled));
  assert.ok(animations.every(animation => animation.frames.every(frame => !("opacity" in frame))),
    "window transitions must preserve the user's background opacity and text contrast");
  assert.deepEqual(completed, [1, 2]);
});

test("rapid reversal starts at the current frame and a late hide completion cannot hide it", async () => {
  const { root, animations, completed, motion } = surface();
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ transform: "matrix(1, 0, 0, 1, 47, 0)", opacity: ".8" });
  try {
    motion.handle({ id: 1, phase: "hide", edge: "right" });
    animations[0].finish(); // Completion microtask is queued just before re-entry.
    motion.handle({ id: 2, phase: "show", edge: "right" });
    assert.equal(animations[1].frames[0].transform, "matrix(1, 0, 0, 1, 47, 0)");
    await flush();
    assert.deepEqual(completed, []);
    assert.equal(root.style.visibility, "");
    animations[1].finish(); await flush();
    assert.deepEqual(completed, [2]);
  } finally { globalThis.getComputedStyle = original; }
});

test("manual reset ignores delayed events and disposal cancels pending work", async () => {
  const { root, animations, completed, motion } = surface();
  motion.handle({ id: 1, phase: "hide", edge: "top" });
  motion.handle({ id: 3, phase: "reset", edge: "top" });
  motion.handle({ id: 2, phase: "hide", edge: "top" });
  assert.equal(animations.length, 1);
  assert.equal(root.style.visibility, "");
  motion.handle({ id: 4, phase: "hide", edge: "top" });
  motion.dispose(); animations[1].finish(); await flush();
  assert.deepEqual(completed, []);
  assert.equal(root.style.willChange, undefined);
});

test("all four edges reveal inward and reduced-motion uses no animation", async () => {
  for (const [edge, transform] of Object.entries({
    left: "translate3d(-100%, 0, 0)", right: "translate3d(100%, 0, 0)",
    top: "translate3d(0, -100%, 0)", bottom: "translate3d(0, 100%, 0)",
  })) {
    const { motion, animations } = surface();
    motion.handle({ id: 1, phase: "park", edge });
    motion.handle({ id: 2, phase: "show", edge });
    assert.equal(animations[0].frames[0].transform, transform);
    motion.dispose();
  }
  const { root, animations } = surface();
  const completed = [];
  const motion = createEdgeMotion(root, id => completed.push(id), () => true);
  motion.handle({ id: 1, phase: "hide", edge: "bottom" });
  assert.equal(root.style.visibility, "hidden");
  motion.handle({ id: 2, phase: "show", edge: "bottom" });
  assert.equal(root.style.visibility, "");
  assert.equal(animations.length, 0);
  assert.deepEqual(completed, [1, 2]);
  await flush();
});

test("a renderer recovery message settles the same transition without a duplicate completion", async () => {
  const { root, motion, animations, completed } = surface();
  motion.handle({ id: 1, phase: "hide", edge: "left" });
  motion.handle({ id: 1, phase: "park", edge: "left" });
  animations[0].finish(); await flush();
  assert.equal(root.style.visibility, "hidden");
  assert.deepEqual(completed, []);
  assert.equal(root.style.willChange, undefined);
});
