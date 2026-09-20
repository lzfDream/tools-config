import { appendLogSegmentPatch, appendLogSegments, createAnsiStreamConverter, createLogSegmentBuffer, tailLogOutput } from "./ansi.js";

const maxLines = 10000;
const maxChars = 1_000_000;
const maxSegments = 10000;
const flushDelay = 250;
const limits = { maxLines, maxChars, maxSegments };

let generation = 0;
let timer = null;
let pendingOutput = "";
let resetOnFlush = false;
let converter = createAnsiStreamConverter();
let buffer = createLogSegmentBuffer();

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function reset(nextGeneration) {
  clearTimer();
  generation = nextGeneration;
  pendingOutput = "";
  resetOnFlush = false;
  converter = createAnsiStreamConverter();
  buffer = createLogSegmentBuffer();
}

function flush() {
  timer = null;
  if (!pendingOutput) return;
  if (resetOnFlush) {
    buffer = appendLogSegments(createLogSegmentBuffer(), pendingOutput, converter, limits);
    self.postMessage({ type: "patch", generation, reset: true, removedCount: 0, segments: buffer.segments });
  } else {
    const patch = appendLogSegmentPatch(buffer, pendingOutput, converter, limits);
    buffer = patch.buffer;
    self.postMessage({ type: "patch", generation, reset: false, removedCount: patch.removedCount, segments: patch.segments });
  }
  pendingOutput = "";
  resetOnFlush = false;
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "reset") {
    reset(event.data.generation);
    return;
  }
  if (event.data?.type !== "append" || event.data.generation !== generation || typeof event.data.value !== "string") return;
  pendingOutput += event.data.value;
  const retained = tailLogOutput(pendingOutput, limits);
  if (retained.truncated) {
    pendingOutput = retained.value;
    resetOnFlush = true;
    converter = createAnsiStreamConverter();
    buffer = createLogSegmentBuffer();
  }
  if (timer === null) timer = setTimeout(flush, flushDelay);
});
