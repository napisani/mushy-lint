import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mushy-nix-deps-"));
  await Bun.write(join(cwd, "scripts/generate-nix-deps.ts"), await Bun.file(new URL("../scripts/generate-nix-deps.ts", import.meta.url)).text());
  await symlink(join(import.meta.dir, "../node_modules"), join(cwd, "node_modules"));
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const fixture = {
  workspaces: { "": { dependencies: { dep: "1.0.0" } } },
  packages: {
    dep: ["dep@1.0.0", "", { dependencies: { child: "2.0.0" } }, "sha512-dep"],
    child: ["child@2.0.0", "", {}, "sha512-child"],
    unused: ["unused@3.0.0", "", {}, "sha512-unused"],
  },
};

async function run(input: { check?: boolean } = {}) {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", join(cwd, "scripts/generate-nix-deps.ts"), ...(input.check ? ["--check"] : [])], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { code, stderr };
}

test("Nix dependencies include the runtime closure and preserve integrity hashes", async () => {
  await Bun.write(join(cwd, "bun.lock"), JSON.stringify(fixture));
  expect((await run()).code).toBe(0);
  const manifest = z.object({ lockHash: z.string(), packages: z.record(z.string(), z.object({ url: z.string(), hash: z.string() })) }).parse(await Bun.file(join(cwd, "nix-deps.json")).json());
  expect(Object.keys(manifest.packages)).toEqual(["child", "dep"]);
  expect(manifest.packages.dep).toEqual({ url: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz", hash: "sha512-dep" });
  expect((await run({ check: true })).code).toBe(0);
  await Bun.write(join(cwd, "bun.lock"), `${JSON.stringify(fixture)}\n`);
  const stale = await run({ check: true });
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("manifest is stale");
});

test("platform-specific runtime packages require explicit packaging", async () => {
  await Bun.write(join(cwd, "bun.lock"), JSON.stringify({ ...fixture, packages: { ...fixture.packages, dep: ["dep@1.0.0", "", { os: "darwin" }, "sha512-dep"] } }));
  const result = await run();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("platform-specific packaging");
});

test("nested runtime versions cannot silently use the root version", async () => {
  await Bun.write(join(cwd, "bun.lock"), JSON.stringify({ ...fixture, packages: { ...fixture.packages, "dep/child": ["child@1.0.0", "", {}, "sha512-child"] } }));
  const result = await run();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("nested version packaging");
});
