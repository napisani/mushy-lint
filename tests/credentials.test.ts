import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassificationConfig } from "../src/config.ts";
import { classificationCredential } from "../src/credentials.ts";
import { createClassification } from "../src/classification.ts";

let cwd: string;
const key = "MUSHY_CREDENTIAL_FILE_TEST_KEY";
const config = ClassificationConfig.parse({ provider: "openrouter", apiKeyEnv: key });
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mushy-credentials-"));
  await Bun.write(join(cwd, ".env"), `export ${key}="literal $(touch should-not-exist) # quoted"\nMUSHY_CREDENTIAL_UNRELATED=not-injected\n`);
});
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

test("reads only the selected literal key without shell execution or environment injection", async () => {
  expect(await classificationCredential({ config, file: join(cwd, ".env") })).toBe("literal $(touch should-not-exist) # quoted");
  expect(process.env[key]).toBeUndefined();
  expect(process.env.MUSHY_CREDENTIAL_UNRELATED).toBeUndefined();
  expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBe(false);
});
test("environment wins over an explicitly named file", async () => {
  process.env[key] = "environment-value";
  try {
    expect(await classificationCredential({ config, file: join(cwd, "missing") })).toBe("environment-value");
  } finally { delete process.env[key]; }
});
test("missing keys return no credential and missing files reveal no values", async () => {
  const missing = ClassificationConfig.parse({ apiKeyEnv: "MUSHY_NO_SUCH_KEY" });
  expect(await classificationCredential({ config: missing, file: join(cwd, ".env") })).toBeUndefined();
  await expect(classificationCredential({ config, file: join(cwd, "missing") })).rejects.toThrow("Unable to read credential file");
});
test("empty classification never reads a credential file", async () => {
  const classification = createClassification({ config, credentialFile: join(cwd, "missing") });
  expect(await classification.classify([])).toEqual({ outcomes: [], executions: [] });
});
