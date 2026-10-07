import { $ } from "bun";

/** Inclusive 1-based line range in the new version of a file. */
export interface LineRange {
  start: number;
  end: number;
}

export type ChangedLines = Map<string, LineRange[]>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff -U0` output into the added/modified line ranges of each file. */
export function parseUnifiedDiff(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let ranges: LineRange[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      ranges = path === "/dev/null" ? null : [];
      if (ranges) {
        changed.set(path.replace(/^b\//, ""), ranges);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (!hunk || !ranges) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A zero count is a pure deletion; nothing in the new file changed.
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return changed;
}

export function overlaps(ranges: LineRange[], start: number, end: number): boolean {
  return ranges.some((r) => r.start <= end && start <= r.end);
}

/** Lines changed in the working tree relative to `ref`, with paths relative to `cwd`. */
export async function changedLinesSince(input: { ref: string; cwd: string }): Promise<ChangedLines> {
  // Explicit prefixes override user config like diff.mnemonicPrefix or diff.noprefix.
  const diff = await $`git diff -U0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ --relative ${input.ref} --`
    .cwd(input.cwd)
    .text();
  return parseUnifiedDiff(diff);
}

/** Tracked and untracked-but-not-ignored files under `paths`, relative to `cwd`. */
export async function listFiles(input: { cwd: string; paths: string[] }): Promise<string[]> {
  const out = await $`git ls-files -z --cached --others --exclude-standard -- ${input.paths}`.cwd(input.cwd).text();
  return out.split("\0").filter((path) => path.length > 0);
}
