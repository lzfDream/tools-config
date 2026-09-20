export interface DiffLine {
  number: number | null;
  text: string;
  kind: "unchanged" | "removed" | "added" | "gap";
}

export function diffLinesWithContext(lines: DiffLine[], context = 2): DiffLine[] {
  const visible = new Uint8Array(lines.length);
  const radius = Math.max(0, context);
  lines.forEach((line, index) => {
    if (line.kind !== "removed" && line.kind !== "added") return;
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length - 1, index + radius);
    visible.fill(1, start, end + 1);
  });
  const result: DiffLine[] = [];
  let previousIndex = -1;
  lines.forEach((line, index) => {
    if (!visible[index]) return;
    if (previousIndex >= 0 && index > previousIndex + 1) result.push({ number: null, text: "...", kind: "gap" });
    result.push(line);
    previousIndex = index;
  });
  return result;
}

export function modifiedLines(baselineText: string, mergedText: string): DiffLine[] {
  const baseline = baselineText.replace(/\r\n|\r/g, "\n").replace(/\n$/, "").split("\n");
  const merged = mergedText.replace(/\r\n|\r/g, "\n").replace(/\n$/, "").split("\n");
  const lcs = Array.from({ length: baseline.length + 1 }, () => new Uint32Array(merged.length + 1));
  for (let left = baseline.length - 1; left >= 0; left -= 1) {
    for (let right = merged.length - 1; right >= 0; right -= 1) {
      lcs[left][right] = baseline[left] === merged[right] ? lcs[left + 1][right + 1] + 1 : Math.max(lcs[left + 1][right], lcs[left][right + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < baseline.length || right < merged.length) {
    if (left < baseline.length && right < merged.length && baseline[left] === merged[right]) {
      lines.push({ number: right + 1, text: merged[right], kind: "unchanged" });
      left += 1;
      right += 1;
    } else if (left < baseline.length && (right >= merged.length || lcs[left + 1][right] >= lcs[left][right + 1])) {
      lines.push({ number: left + 1, text: baseline[left], kind: "removed" });
      left += 1;
    } else {
      lines.push({ number: right + 1, text: merged[right], kind: "added" });
      right += 1;
    }
  }
  return lines;
}
