import { Language, Parser, type Tree } from "web-tree-sitter";
import tsxWasm from "../grammars/typescript/tsx.wasm" with { type: "file" };
import typescriptWasm from "../grammars/typescript/typescript.wasm" with { type: "file" };
import coreWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };

export type LanguageId = "typescript";

export interface SourceParser {
  /** Returns null when no grammar of `language` handles the file's extension. Callers must `delete()` the tree. */
  parse(input: { file: string; source: string; language: LanguageId }): Tree | null;
  dispose(): void;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".mts", ".cts"];

export async function createSourceParser(): Promise<SourceParser> {
  // Passing the bytes, not a path, is what lets `bun build --compile` embed the runtime.
  await Parser.init({ wasmBinary: await Bun.file(coreWasm).bytes() });
  const typescript = await Language.load(await Bun.file(typescriptWasm).bytes());
  const tsx = await Language.load(await Bun.file(tsxWasm).bytes());
  const parser = new Parser();

  function grammarFor(file: string): Language | null {
    if (file.endsWith(".tsx")) {
      return tsx;
    }
    if (!TYPESCRIPT_EXTENSIONS.some((ext) => file.endsWith(ext))) {
      return null;
    }
    return typescript;
  }

  return {
    parse({ file, source }) {
      const grammar = grammarFor(file);
      if (!grammar) {
        return null;
      }
      parser.setLanguage(grammar);
      return parser.parse(source);
    },
    dispose() {
      parser.delete();
    },
  };
}
