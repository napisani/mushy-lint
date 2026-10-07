export const CONFIG = `version: 2
fileSets:
  source:
    include: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: ["src/skip/**"]
targets:
  function:
    language: typescript
    root: code
    query: |
      (function_declaration) @code
      (function_expression) @code
      (arrow_function) @code
      (method_definition) @code
conditions:
  catches:
    language: typescript
    query: |
      (try_statement handler: (catch_clause))
sections:
  - name: ts
    language: typescript
    files: source
    rules:
      - id: catch
        target: function
        includeIf: catches
        score: Does \`code\` discard errors?
      - id: purpose
        target: function
        score: Does \`code\` have one purpose?
`;
