import { parseEnv } from "node:util";
import type { ClassificationConfig } from "./config.ts";

export async function classificationCredential(input: { config: ClassificationConfig; file?: string }): Promise<string | undefined> {
  const name = input.config.apiKeyEnv ?? (input.config.provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY");
  const environment = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
  if (environment) { return environment; }
  if (input.file === undefined) { return undefined; }
  let text: string;
  try {
    text = await Bun.file(input.file).text();
  } catch {
    throw new Error(`Unable to read credential file: ${input.file}`);
  }
  // Parse literal dotenv values without executing shell expressions or changing process.env.
  const values = parseEnv(text);
  return Object.hasOwn(values, name) ? values[name] || undefined : undefined;
}
