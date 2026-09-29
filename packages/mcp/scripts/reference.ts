import ts from "typescript"

const root = new URL("../../../", import.meta.url).pathname
const entries = [
  { name: "@answerable/auth", file: "packages/auth/src/index.ts", about: "Verify Answerable ID access tokens in any service." },
  { name: "@answerable/auth/testing", file: "packages/auth/src/testing.ts", about: "An in-process issuer that signs ID-shaped test tokens." },
  { name: "@answerable/mcp", file: "packages/mcp/src/index.ts", about: "Define tools, mutations and providers, and serve them as an MCP server." },
  { name: "@answerable/mcp/build", file: "packages/mcp/src/build.ts", about: "Bundle an MCP Apps view into one HTML resource." },
  { name: "@answerable/mcp/testing", file: "packages/mcp/src/testing.ts", about: "Serve a provider in-process and run the conformance kit against it." },
]

const { config } = ts.readConfigFile(`${root}packages/mcp/tsconfig.json`, ts.sys.readFile)
const options = ts.parseJsonConfigFileContent(config, ts.sys, `${root}packages/mcp`).options

// TypeScript's own declaration emit, formatted to this repository's style: two spaces, no semicolons.
function printDeclarations(program: ts.Program, file: ts.SourceFile) {
  let text = ""
  program.emit(file, (_name, output) => { text = output }, undefined, true)
  const name = "declarations.d.ts"
  const service = ts.createLanguageService({
    getScriptFileNames: () => [name],
    getScriptVersion: () => "1",
    getScriptSnapshot: file => file === name ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => ({}),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: file => file === name,
    readFile: file => file === name ? text : undefined,
  })
  const settings = { ...ts.getDefaultFormatCodeSettings("\n"), indentSize: 2, tabSize: 2, semicolons: ts.SemicolonPreference.Remove }
  for (const edit of service.getFormattingEditsForDocument(name, settings).sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length)
  }
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
}

// The declaration of `name` as it is written in a formatted declaration file, without its comment or `export declare`,
// after the file's private types it uses (the ones the file does not export), so that the block stands alone.
function declarationOf(printed: ts.SourceFile, name: string) {
  const isExported = (statement: ts.Statement) => ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const isType = (statement: ts.Statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration => ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
  const named = (statement: ts.Statement) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.some(declaration => declaration.name.getText(printed) === name)
    : (isType(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name
  const priv = new Map(printed.statements.filter(isType).filter(statement => !isExported(statement)).map(statement => [statement.name.text, statement]))
  const used = new Set<ts.Statement>()
  const visit = (node: ts.Node) => {
    const found = ts.isIdentifier(node) ? priv.get(node.text) : undefined
    if (found && !used.has(found)) {
      used.add(found)
      visit(found)
    }
    ts.forEachChild(node, visit)
  }
  const declared = printed.statements.filter(named)
  declared.forEach(visit)
  return [...printed.statements.filter(statement => used.has(statement)), ...declared]
    .map(statement => statement.getText(printed).replace(/^export\s+(declare\s+)?/, "")).join("\n\n")
}

const text = (parts: ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts).trim()

/** The API reference page, generated from the documentation comments of every public entry point. */
export function renderReference() {
  const program = ts.createProgram(entries.map(entry => root + entry.file), { ...options, noEmit: false, declaration: true, emitDeclarationOnly: true })
  const checker = program.getTypeChecker()
  const printed = new Map<ts.SourceFile, ts.SourceFile>()
  const owner = (path: string) => /packages\/([^/]+)\//.exec(path)![1]!
  const page = [
    "---",
    "title: API reference",
    'description: "Every export of @answerable/auth and @answerable/mcp: its declaration, what it is for and, for the functions authors start from, an example."',
    "---",
    "",
    "Generated from the documentation comments in the source by `bun run --filter @answerable/mcp reference`; edit the comments, not this page. [Author an MCP](/docs/mcp/authoring) and [Test an MCP](/docs/mcp/testing) show these exports in use.",
  ]
  for (const entry of entries) {
    const file = program.getSourceFile(root + entry.file)!
    page.push("", `## ${entry.name}`, "", entry.about)
    for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(file)!)) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const source = target.declarations![0]!.getSourceFile()
      page.push("", `### ${symbol.name}`)
      if (owner(source.fileName) !== owner(file.fileName)) {
        page.push("", `Re-exported from \`@answerable/${owner(source.fileName)}\`; see [${symbol.name}](#${symbol.name.toLowerCase()}).`)
        continue
      }
      const description = text(target.getDocumentationComment(checker))
      if (!description) throw new Error(`${entry.name} exports ${symbol.name} without a documentation comment; add one sentence saying what it is for`)
      if (!printed.has(source)) printed.set(source, printDeclarations(program, source))
      const tags = target.getJsDocTags(checker)
      const parameters = tags.filter(tag => tag.name === "param").map(tag => `- \`${text(tag.text?.slice(0, 1))}\`: ${text(tag.text?.slice(1))}`)
      page.push("", "```ts", declarationOf(printed.get(source)!, target.name), "```", "", description)
      if (parameters.length) page.push("", "**Parameters**", "", ...parameters)
      for (const example of tags.filter(tag => tag.name === "example")) page.push("", "**Example**", "", text(example.text))
    }
  }
  return `${page.join("\n")}\n`
}

if (import.meta.main) {
  await Bun.write(new URL("../../../apps/web/content/docs/mcp/reference.mdx", import.meta.url), renderReference())
  console.log("Wrote apps/web/content/docs/mcp/reference.mdx")
}
