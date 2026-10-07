import { load } from "js-yaml";
import { posix } from "node:path";
import { z } from "zod";

const Dependencies = z.record(z.string().regex(/^(@[\w-][\w.-]*\/)?[\w-][\w.-]*$/), z.string());
const Package = z.tuple([
  z.string().regex(/^.+@[^@]+$/),
  z.literal(""),
  z.object({
    dependencies: Dependencies.default({}),
    optionalDependencies: Dependencies.default({}),
    os: z.string().optional(),
    cpu: z.string().optional(),
  }),
  z.string().regex(/^sha512-/),
]);
const Lock = z.object({
  workspaces: z.object({ "": z.object({ dependencies: Dependencies }) }),
  packages: z.record(z.string(), Package),
});

const lockText = await Bun.file(new URL("../bun.lock", import.meta.url)).text();
const lock = Lock.parse(load(lockText));
const pending = Object.keys(lock.workspaces[""].dependencies);
const packages = new Map<string, { url: string; hash: string }>();
while (pending.length > 0) {
  const name = pending.pop();
  if (name === undefined || packages.has(name)) {
    continue;
  }
  const entry = lock.packages[name];
  if (!entry) {
    throw new Error(`Missing flat runtime dependency in bun.lock: ${name}`);
  }
  if (Object.keys(lock.packages).some((key) => key.startsWith(`${name}/`))) {
    throw new Error(`Nix runtime dependency needs nested version packaging: ${name}`);
  }
  const [resolved, , metadata, hash] = entry;
  if (metadata.os || metadata.cpu || Object.keys(metadata.optionalDependencies).length > 0) {
    throw new Error(`Nix runtime dependency needs platform-specific packaging: ${name}`);
  }
  const at = resolved.lastIndexOf("@");
  const packageName = resolved.slice(0, at);
  const version = resolved.slice(at + 1);
  packages.set(name, { url: `https://registry.npmjs.org/${packageName}/-/${posix.basename(packageName)}-${version}.tgz`, hash });
  pending.push(...Object.keys(metadata.dependencies));
}
const manifest = {
  lockHash: new Bun.CryptoHasher("sha256").update(lockText).digest("hex"),
  packages: Object.fromEntries([...packages].sort(([a], [b]) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  })),
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;
const path = new URL("../nix-deps.json", import.meta.url);
if (Bun.argv.includes("--check")) {
  if (!(await Bun.file(path).exists()) || await Bun.file(path).text() !== output) {
    throw new Error("Nix dependency manifest is stale; run bun run nix:deps.");
  }
} else {
  await Bun.write(path, output);
}
