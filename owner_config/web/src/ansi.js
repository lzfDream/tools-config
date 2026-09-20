import AnsiToHtml from "ansi-to-html";

export function ansiToHtml(value) {
  return new AnsiToHtml({ escapeXML: true }).toHtml(value);
}

export function createAnsiStreamConverter() {
  return new AnsiToHtml({ escapeXML: true, stream: true });
}

export function splitLogOutput(value, maxLineBreaks = 100, maxChars = 65_536) {
  if (!value) return [];
  const segments = [];
  let start = 0;
  let lineBreaks = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") lineBreaks += 1;
    if (lineBreaks < maxLineBreaks && index - start + 1 < maxChars) continue;
    segments.push(value.slice(start, index + 1));
    start = index + 1;
    lineBreaks = 0;
  }
  if (start < value.length) segments.push(value.slice(start));
  return segments;
}

export function createLogSegmentBuffer() {
  return { segments: [], lineBreaks: 0, chars: 0, nextId: 0 };
}

export function appendLogSegments(buffer, value, converter, { maxLines = 10000, maxChars = 1_000_000, maxSegments = 10000 } = {}) {
  if (!value) return buffer;
  let nextId = buffer.nextId;
  const additions = splitLogOutput(value).map((text) => ({
    id: ++nextId,
    html: converter.toHtml(text),
    lineBreaks: text.split("\n").length - 1,
    chars: text.length,
    endsWithLineBreak: text.endsWith("\n"),
  }));
  const segments = [...buffer.segments, ...additions];
  let lineBreaks = buffer.lineBreaks + additions.reduce((total, segment) => total + segment.lineBreaks, 0);
  let chars = buffer.chars + additions.reduce((total, segment) => total + segment.chars, 0);
  let removeCount = 0;
  const retainedLineCount = () => lineBreaks + (segments.length > removeCount && !segments.at(-1).endsWithLineBreak ? 1 : 0);
  while (removeCount < segments.length && (retainedLineCount() > maxLines || chars > maxChars || segments.length - removeCount > maxSegments)) {
    lineBreaks -= segments[removeCount].lineBreaks;
    chars -= segments[removeCount].chars;
    removeCount += 1;
  }
  return {
    segments: removeCount ? segments.slice(removeCount) : segments,
    lineBreaks,
    chars,
    nextId,
  };
}

export function appendLogSegmentPatch(buffer, value, converter, options) {
  const previousSegments = buffer.segments;
  const previousNextId = buffer.nextId;
  const nextBuffer = appendLogSegments(buffer, value, converter, options);
  const firstRetainedId = nextBuffer.segments[0]?.id ?? nextBuffer.nextId + 1;
  let removedCount = 0;
  while (removedCount < previousSegments.length && previousSegments[removedCount].id < firstRetainedId) removedCount += 1;
  return {
    buffer: nextBuffer,
    removedCount,
    segments: nextBuffer.segments.filter((segment) => segment.id > previousNextId),
  };
}

export function tailLogOutput(value, { maxLines = 10000, maxChars = 1_000_000 } = {}) {
  if (!value) return { value: "", truncated: false };
  let start = Math.max(0, value.length - maxChars);
  let lineBreaks = 0;
  const allowedLineBreaks = value.endsWith("\n") ? maxLines : Math.max(0, maxLines - 1);
  for (let index = value.length - 1; index >= start; index -= 1) {
    if (value[index] !== "\n") continue;
    lineBreaks += 1;
    if (lineBreaks <= allowedLineBreaks) continue;
    start = index + 1;
    break;
  }
  if (start > 0 && value[start - 1] !== "\n") {
    const nextLine = value.indexOf("\n", start);
    if (nextLine >= 0 && nextLine + 1 < value.length) start = nextLine + 1;
  }
  return { value: value.slice(start), truncated: start > 0 };
}
