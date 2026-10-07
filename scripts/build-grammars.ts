#!/usr/bin/env bun
/* oxlint-disable no-await-in-loop -- each step is an ordered shell command that depends on the previous one */
// Rebuilds the vendored grammar .wasm files from the revisions pinned in
// grammars/grammars.json. Requires the tree-sitter CLI (>= 0.26.1, which
// downloads wasi-sdk on first use).
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const Pins = z.record(
  z.string(),
  z.object({
    repo: z.url(),
    rev: z.string().regex(/^[0-9a-f]{40}$/),
    builds: z.record(z.string(), z.string()),
  }),
);

const grammarsDir = resolve(import.meta.dir, "../grammars");
const pins = Pins.parse(await Bun.file(join(grammarsDir, "grammars.json")).json());

for (const [name, pin] of Object.entries(pins)) {
  const checkout = await mkdtemp(join(tmpdir(), `grammar-${name}-`));
  try {
    await $`git init -q ${checkout}`;
    await $`git -C ${checkout} fetch -q --depth 1 ${pin.repo} ${pin.rev}`;
    await $`git -C ${checkout} checkout -q FETCH_HEAD`;
    const outDir = join(grammarsDir, name);
    await $`mkdir -p ${outDir}`;
    await $`cp ${join(checkout, "LICENSE")} ${join(outDir, "LICENSE")}`;
    for (const [wasm, sourceDir] of Object.entries(pin.builds)) {
      await $`tree-sitter build --wasm -o ${join(outDir, wasm)} ${join(checkout, sourceDir)}`;
      process.stdout.write(`built ${name}/${wasm} from ${pin.rev.slice(0, 12)}\n`);
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
