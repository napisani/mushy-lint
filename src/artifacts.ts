import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisReport } from "./model.ts";

export async function createArtifacts(directory: string): Promise<void> {
  // Refuse existing directories so a review cannot overwrite another run or follow its symlinks.
  await mkdir(directory, { mode: 0o700 });
}

export async function writeArtifact(input: { directory: string; name: string; content: string }): Promise<void> {
  await writeFile(join(input.directory, input.name), input.content, { mode: 0o600, flag: "wx" });
}

export function reviewLedger(report: AnalysisReport) {
  return report.results.map((result) => ({
    id: result.id, section: result.section, rule: result.rule, location: result.location,
    question: result.question, status: result.status,
    assessment: result.status === "evaluated" ? { score: result.score } : { reason: result.reason, message: result.message },
    decision: null, evidence: "", nextAction: "",
  }));
}
