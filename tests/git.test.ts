import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLinesSince, listFiles, overlaps, parseUnifiedDiff } from "../src/git.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@ export const a = 1;
-old
+new
@@ -10,0 +11,3 @@ function f() {
+one
+two
+three
@@ -20,2 +23,0 @@
-gone
-gone
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+x
+y
`;

describe("parseUnifiedDiff", () => {
  test("collects added line ranges per file, ignoring pure deletions and deleted files", () => {
    expect(parseUnifiedDiff(DIFF)).toEqual(
      new Map([
        ["src/a.ts", [{ start: 3, end: 3 }, { start: 11, end: 13 }]],
        ["src/new.ts", [{ start: 1, end: 2 }]],
      ]),
    );
  });
});

describe("changedLinesSince", () => {
  test("reports paths relative to cwd regardless of the user's diff prefix config", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mushy-lint-git-"));
    await $`git init -q && git config diff.mnemonicPrefix true && git config user.email t@t && git config user.name t`.cwd(repo);
    await Bun.write(join(repo, "pkg/a.ts"), "one\ntwo\n");
    await $`git add -A && git commit -qm init`.cwd(repo);
    await Bun.write(join(repo, "pkg/a.ts"), "one\nTWO\nthree\n");

    const changed = await changedLinesSince({ ref: "HEAD", cwd: join(repo, "pkg") });
    expect(changed).toEqual(new Map([["a.ts", [{ start: 2, end: 3 }]]]));
  });
});

test("file discovery preserves Unicode, quoted, and newline-containing paths", async () => {
  const repo = await mkdtemp(join(tmpdir(), "mushy-paths-"));
  try {
    await $`git init -q`.cwd(repo);
    const paths = ["src/résumé.ts", 'src/a"b.ts', "src/line\nbreak.ts"];
    await Promise.all(paths.map((path) => Bun.write(join(repo, path), "const value = 1;")));
    expect((await listFiles({ cwd: repo, paths: ["src"] })).sort()).toEqual(paths.sort());
  } finally { await rm(repo, { recursive: true, force: true }); }
});

describe("overlaps", () => {
  const ranges = [{ start: 11, end: 13 }];
  test("detects partial and enclosing overlap", () => {
    expect(overlaps(ranges, 13, 20)).toBe(true);
    expect(overlaps(ranges, 1, 50)).toBe(true);
  });
  test("adjacent is not overlapping", () => {
    expect(overlaps(ranges, 14, 15)).toBe(false);
    expect(overlaps(ranges, 5, 10)).toBe(false);
  });
});
