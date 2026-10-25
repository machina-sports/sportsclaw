/**
 * Inference boundary guard — AST scan of production source
 *
 * Every runtime generation/stream/object/image/embedding call must cross
 * `src/inference/run.ts`; every runtime Jev decision must cross
 * `src/inference/decide.ts`; raw image provider backends are reachable only
 * through the dispatcher that the boundary wraps. The scan walks every
 * `src/**\/*.ts` file (recursive readdir, not a list) with the TypeScript
 * parser, so aliases, namespace/default imports, dynamic import, require,
 * re-exports and direct model `doGenerate`/`doStream` access all count.
 *
 * The scanner is proved against its own synthetic cases first.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");

const BOUNDARY = "inference/run.ts";
const DECIDE = "inference/decide.ts";
const DECISION_CLIENT = "decision-client.ts";
const IMAGE_GEN = "image-gen.ts";

const SDK_INFERENCE = new Set([
  "generateText", "streamText", "generateObject", "streamObject",
  "generateImage", "experimental_generateImage", "embed", "embedMany",
  "experimental_generateSpeech", "experimental_transcribe", "generateSpeech",
  "transcribe", "rerank", "Agent", "ToolLoopAgent", "Experimental_Agent",
]);
const MODEL_METHODS = new Set(["doGenerate", "doStream"]);
const IMAGE_DISPATCH = "generateImageForProvider";
const IMAGE_BACKENDS = new Set(["generateImageGoogle", "generateImageOpenAI", "generateImageAzureFoundry"]);

const isAi = (spec) => spec === "ai" || spec.startsWith("ai/");
const isDecisionClient = (spec) => /(^|\/)decision-client(\.js)?$/.test(spec);
const isImageGen = (spec) => /(^|\/)image-gen(\.js)?$/.test(spec);
const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);

/**
 * Scan one source file. `rel` is the posix path relative to src/.
 * Returns a list of `rel:line rule` strings.
 */
function scan(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const flag = (node, rule) =>
    out.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${rule}`);

  const isBoundary = rel === BOUNDARY;
  const imageLocals = new Map(); // local identifier -> imported image-gen export
  const imageNamespaces = new Set();
  const requireNames = new Set(["require"]);
  let decisionClientImported = false;

  /** Strip parentheses and `await` around an expression. */
  const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))) node = node.expression;
    return node;
  };
  /** Specifier of a dynamic `import(...)` or `require(...)` expression, if literal. */
  const loadedModule = (node) => {
    const n = unwrap(node);
    if (!n || !ts.isCallExpression(n)) return undefined;
    const callee = n.expression;
    const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requireNames.has(callee.text));
    return loads ? literal(n.arguments[0]) : undefined;
  };
  /** `x.name`, `x["name"]` and `` x[`name`] `` all name the same member. */
  const memberName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression);
    return undefined;
  };
  /** Record what a binding of a loaded image-gen module makes callable. */
  const bindImage = (name) => {
    if (ts.isIdentifier(name)) {
      imageNamespaces.add(name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const el of name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      if (el.dotDotDotToken) {
        imageNamespaces.add(el.name.text);
        continue;
      }
      const key = el.propertyName ?? el.name;
      const imported = ts.isComputedPropertyName(key) ? literal(key.expression)
        : ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (imported) imageLocals.set(el.name.text, imported);
    }
  };

  // Pass 0: createRequire aliases, then dynamic import()/require() bindings,
  // so call sites below see every way a module can be loaded.
  const findRequires = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && callee.text === "createRequire" && ts.isIdentifier(node.name)) {
        requireNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, findRequires);
  };
  findRequires(sf);
  const findLoads = (node) => {
    const spec = ts.isCallExpression(node) ? loadedModule(node) : undefined;
    if (spec && isDecisionClient(spec)) decisionClientImported = true;
    if (spec && isImageGen(spec)) {
      let use = node;
      while (use.parent && (ts.isParenthesizedExpression(use.parent) || ts.isAwaitExpression(use.parent))) use = use.parent;
      const p = use.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer === use) {
        bindImage(p.name);
      } else if (p && ts.isPropertyAccessExpression(p) && p.expression === use && p.name.text === "then") {
        const call = p.parent;
        const cb = call && ts.isCallExpression(call) && call.expression === p ? call.arguments[0] : undefined;
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) bindImage(cb.parameters[0].name);
      }
    }
    ts.forEachChild(node, findLoads);
  };
  findLoads(sf);

  // Pass 1: imports and bindings.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = literal(stmt.moduleSpecifier);
      const clause = stmt.importClause;
      if (spec && isDecisionClient(spec)) decisionClientImported = true;
      if (spec && isImageGen(spec) && clause && !clause.isTypeOnly) {
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) imageNamespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!el.isTypeOnly) imageLocals.set(el.name.text, (el.propertyName ?? el.name).text);
          }
        }
      }
      if (!spec || !isAi(spec) || !clause || clause.isTypeOnly || isBoundary) continue;
      if (clause.name) flag(stmt, "default import of ai");
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) flag(stmt, "namespace import of ai");
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && SDK_INFERENCE.has(imported)) flag(el, `ai.${imported} imported outside the boundary`);
        }
      }
    } else if (ts.isImportEqualsDeclaration(stmt) && !stmt.isTypeOnly) {
      const ref = stmt.moduleReference;
      const spec = ts.isExternalModuleReference(ref) ? literal(ref.expression) ?? "" : "";
      if (isImageGen(spec)) imageNamespaces.add(stmt.name.text);
      if (isDecisionClient(spec)) decisionClientImported = true;
      if (!isBoundary && isAi(spec)) flag(stmt, "import = require('ai')");
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && !isBoundary) {
      const spec = literal(stmt.moduleSpecifier);
      if (!spec || !isAi(spec)) continue;
      const ec = stmt.exportClause;
      if (!ec) flag(stmt, "export * from ai");
      else if (ts.isNamespaceExport(ec)) flag(stmt, "export * as ns from ai");
      else {
        for (const el of ec.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && SDK_INFERENCE.has(imported)) flag(el, `re-export of ai.${imported}`);
        }
      }
    }
  }

  const enclosingFunctionName = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    }
    return undefined;
  };

  // Pass 2: expressions.
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = literal(node.arguments[0]);
      if (!isBoundary && arg0 && isAi(arg0)) {
        if (callee.kind === ts.SyntaxKind.ImportKeyword) flag(node, "dynamic import('ai')");
        else if (ts.isIdentifier(callee) && requireNames.has(callee.text)) flag(node, "require('ai')");
      }

      // Jev decisions: only the typed boundary (and the client itself),
      // whether the client is imported statically or loaded dynamically.
      if (
        decisionClientImported &&
        rel !== DECIDE &&
        rel !== DECISION_CLIENT &&
        memberName(callee) === "decide"
      ) {
        flag(node, "JevDecisionClient.decide outside inference/decide.ts");
      }

      // Image backends: direct locals, namespace members (dot, string or
      // template element access) and members of an inline dynamic import.
      let imageName;
      if (ts.isIdentifier(callee)) {
        imageName = rel === IMAGE_GEN ? callee.text : imageLocals.get(callee.text);
      } else {
        const member = memberName(callee);
        const owner = member === undefined ? undefined : unwrap(callee.expression);
        if (owner && ((ts.isIdentifier(owner) && imageNamespaces.has(owner.text)) || isImageGen(loadedModule(owner) ?? ""))) {
          imageName = member;
        }
      }
      if (imageName === IMAGE_DISPATCH && rel !== BOUNDARY) {
        flag(node, "generateImageForProvider outside inference/run.ts");
      } else if (imageName && IMAGE_BACKENDS.has(imageName)) {
        const allowed = rel === IMAGE_GEN && enclosingFunctionName(node) === IMAGE_DISPATCH;
        if (!allowed) flag(node, `raw image backend ${imageName} outside the dispatcher`);
      }
    }

    if (!isBoundary) {
      if (ts.isPropertyAccessExpression(node) && MODEL_METHODS.has(node.name.text)) {
        flag(node, `model.${node.name.text} outside the boundary`);
      } else if (ts.isElementAccessExpression(node) && MODEL_METHODS.has(literal(node.argumentExpression) ?? "")) {
        flag(node, `model[${literal(node.argumentExpression)}] outside the boundary`);
      } else if (ts.isBindingElement(node)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) && MODEL_METHODS.has(key.text) && ts.isObjectBindingPattern(node.parent)) {
          flag(node, `destructured ${key.text} outside the boundary`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir = srcDir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(c|m)?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

const posixRel = (full) => relative(srcDir, full).split(sep).join("/");

/** Value (non type-only) relative imports of a file, resolved to src-relative .ts paths. */
function valueImports(rel) {
  const full = join(srcDir, rel);
  const sf = ts.createSourceFile(rel, readFileSync(full, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const nb = node.importClause?.namedBindings;
      const onlyTypes = nb && ts.isNamedImports(nb) && nb.elements.length > 0 && !node.importClause.name &&
        nb.elements.every((el) => el.isTypeOnly);
      if (!onlyTypes) specs.push(literal(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      specs.push(literal(node.moduleSpecifier));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specs.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs.filter(Boolean).map((spec) =>
    spec.startsWith(".")
      ? posixRel(resolve(dirname(full), spec)).replace(/\.js$/, ".ts")
      : spec,
  );
}

// ---------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------

describe("inference guard scanner (synthetic cases)", () => {
  const bad = {
    "named import": ['engine.ts', 'import { generateText } from "ai";\ngenerateText({});'],
    "aliased import": ['router.ts', 'import { streamText as s } from "ai";\ns({});'],
    "mixed helpers + alias": ['x.ts', 'import { tool, generateText as g, type ToolSet } from "ai";'],
    "namespace import": ['x.ts', 'import * as ai from "ai";\nai.generateText({});'],
    "default import": ['x.ts', 'import ai from "ai";'],
    "subpath import": ['x.ts', 'import { generateObject } from "ai/rsc";'],
    "agent class": ['x.ts', 'import { ToolLoopAgent } from "ai";'],
    "dynamic import": ['x.ts', 'const { generateText } = await import("ai");'],
    "require": ['x.ts', 'const ai = require("ai");'],
    "createRequire alias": ['x.ts', 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nr("ai");'],
    "import equals": ['x.ts', 'import ai = require("ai");'],
    "named re-export": ['index.ts', 'export { generateText } from "ai";'],
    "aliased re-export": ['index.ts', 'export { streamObject as so } from "ai";'],
    "star re-export": ['index.ts', 'export * from "ai";'],
    "namespace re-export": ['index.ts', 'export * as sdk from "ai";'],
    "doGenerate property": ['x.ts', 'await model.doGenerate(opts);'],
    "doStream element access": ['x.ts', 'await model["doStream"](opts);'],
    "destructured doGenerate": ['x.ts', 'const { doGenerate } = model;'],
    "jev decide": ['evidence-verifier.ts', 'import { JevDecisionClient } from "./decision-client.js";\nawait new JevDecisionClient().decide(req);'],
    "jev decide via type-only import": ['routing/capability-router.ts', 'import type { JevDecisionClient } from "../decision-client.js";\ndeclare const c: JevDecisionClient;\nawait c.decide(req);'],
    "aliased image dispatcher": ['engine.ts', 'import { generateImageForProvider as gen } from "./image-gen.js";\nawait gen("openai", "p");'],
    "namespaced image backend": ['operate.ts', 'import * as img from "./image-gen.js";\nawait img.generateImageOpenAI("p");'],
    "dispatcher call inside image-gen tool": ['image-gen.ts', 'export function createGenerateImageTool() {\n  return generateImageForProvider("openai", "p");\n}'],
    "backend call outside dispatcher": ['image-gen.ts', 'export function other() { return generateImageGoogle("p"); }'],
    // Review v1 item 3: dynamic native-image import / destructure.
    "dynamic image import destructure": ['operate.ts', 'const { generateImageOpenAI } = await import("./image-gen.js");\nawait generateImageOpenAI("p");'],
    "dynamic image import aliased dispatcher": ['engine.ts', 'const { generateImageForProvider: gen } = await import("./inference/image-gen.js");\nawait gen("openai", "p");'],
    "dynamic image namespace": ['engine.ts', 'const img = await import("./image-gen.js");\nawait img.generateImageGoogle("p");'],
    "dynamic image import then-destructure": ['operate.ts', 'import("./image-gen.js").then(({ generateImageAzureFoundry }) => generateImageAzureFoundry("p"));'],
    // Image namespace string-element calls.
    "image namespace string-element backend": ['operate.ts', 'import * as img from "./image-gen.js";\nawait img["generateImageGoogle"]("p");'],
    "image namespace string-element dispatcher": ['engine.ts', 'import * as img from "./inference/image-gen.js";\nawait img["generateImageForProvider"]("openai", "p");'],
    "image namespace template-element backend": ['operate.ts', 'import * as img from "./image-gen.js";\nawait img[`generateImageOpenAI`]("p");'],
    // Jev decide via element access and via dynamic import.
    "jev decide element access": ['evidence-verifier.ts', 'import { JevDecisionClient } from "./decision-client.js";\nawait new JevDecisionClient()["decide"](req);'],
    "jev decide template element access": ['decision-relay.ts', 'import { JevDecisionClient } from "./decision-client.js";\nconst c = new JevDecisionClient();\nawait c[`decide`](req);'],
    "dynamic jev import": ['evidence-verifier.ts', 'const { JevDecisionClient } = await import("./decision-client.js");\nawait new JevDecisionClient().decide(req);'],
    "dynamic jev namespace + element access": ['routing/capability-router.ts', 'const m = await import("../decision-client.js");\nawait new m.JevDecisionClient()["decide"](req);'],
  };
  for (const [label, [rel, text]] of Object.entries(bad)) {
    it(`flags ${label}`, () => {
      assert.ok(scan(rel, text).length >= 1, `${label} must be a violation`);
    });
  }

  const good = {
    "type-only import + typeof": ['router.ts', 'import type { generateText, ToolSet } from "ai";\ntype M = Parameters<typeof generateText>[0]["model"];'],
    "helpers and inline type specifier": ['subagent.ts', 'import { tool, jsonSchema, stepCountIs, hasToolCall, Output, type generateText } from "ai";'],
    "import type expression": ['x.ts', 'type T = typeof import("ai");'],
    "comments and strings": ['x.ts', '// generateText({}) model.doGenerate()\nconst s = "doGenerate"; const t = `streamText(`;'],
    "type re-export": ['types.ts', 'export type { ModelMessage } from "ai";'],
    "provider construction": ['llm-providers.ts', 'import { createOpenAI } from "@ai-sdk/openai";\nconst p = createOpenAI({});'],
    "boundary itself": [BOUNDARY, 'import { generateText, streamText } from "ai";\nimport { generateImageForProvider } from "../image-gen.js";\nexport const g = (p) => generateText(p);\nexport const i = () => generateImageForProvider("openai", "p");'],
    "decide boundary": [DECIDE, 'import type { JevDecisionClient } from "../decision-client.js";\nexport const d = (c: JevDecisionClient, r: any) => c.decide(r);'],
    "decision client itself": [DECISION_CLIENT, 'class JevDecisionClient { async decide() {} }\nconst x = new JevDecisionClient(); x.decide();'],
    "unrelated decide method": ['heartbeat.ts', 'const router = { decide: () => 1 };\nrouter.decide();'],
    "dispatcher body": [IMAGE_GEN, 'export async function generateImageForProvider(p: string) {\n  if (p === "google") return generateImageGoogle("x");\n  return generateImageOpenAI("x");\n}'],
    "image re-export from index": ['index.ts', 'export { generateImageForProvider, generateImageGoogle } from "./image-gen.js";'],
    // Static imports/types and low-level adapter compatibility stay valid.
    "type-only image namespace": ['engine.ts', 'import type * as img from "./image-gen.js";\ntype G = typeof img.generateImageOpenAI;'],
    "image import type expression": ['engine.ts', 'type T = typeof import("./image-gen.js")["generateImageGoogle"];'],
    "dynamic image import of a non-backend export": ['operate.ts', 'const { createGenerateImageTool, azureFoundryImageSize } = await import("./image-gen.js");\ncreateGenerateImageTool();\nazureFoundryImageSize("1:1");'],
    "image namespace non-backend element": ['operate.ts', 'import * as img from "./image-gen.js";\nimg["azureFoundryImageSize"]("1:1");'],
    "boundary dynamic image import": [BOUNDARY, 'const { generateImageForProvider } = await import("./image-gen.js");\nexport const i = () => generateImageForProvider("openai", "p");'],
    "dynamic decision client construction only": ['evidence-verifier.ts', 'const { JevDecisionClient } = await import("./decision-client.js");\nexport const c = new JevDecisionClient({});'],
    "decide boundary element access": [DECIDE, 'import type { JevDecisionClient } from "../decision-client.js";\nexport const d = (c: JevDecisionClient, r: any) => c["decide"](r);'],
    "unrelated decide element access": ['heartbeat.ts', 'const router = { decide: () => 1 };\nrouter["decide"]();'],
  };
  for (const [label, [rel, text]] of Object.entries(good)) {
    it(`allows ${label}`, () => {
      assert.deepEqual(scan(rel, text), [], label);
    });
  }
});

// ---------------------------------------------------------------------------
// Production source
// ---------------------------------------------------------------------------

describe("inference boundary in production source", () => {
  const files = sourceFiles();

  it("walks the real tree, including nested directories", () => {
    const rels = files.map(posixRel);
    assert.ok(rels.length > 50, `expected a real source tree, saw ${rels.length} files`);
    for (const nested of ["engine.ts", "inference/model-role-router.ts", "intelligence/momentum-evaluator.ts", "routing/capability-router.ts"]) {
      assert.ok(rels.includes(nested), `scan must include ${nested}`);
    }
  });

  it("has no runtime inference bypass", () => {
    const violations = files.flatMap((f) => scan(posixRel(f), readFileSync(f, "utf-8")));
    assert.deepEqual(violations, [], `runtime inference must cross the boundary:\n${violations.join("\n")}`);
  });

  it("has a boundary module that actually executes the SDK", () => {
    assert.ok(existsSync(join(srcDir, BOUNDARY)), `${BOUNDARY} must exist`);
    assert.ok(existsSync(join(srcDir, DECIDE)), `${DECIDE} must exist`);
    const runImports = valueImports(BOUNDARY);
    assert.ok(runImports.includes("ai"), "run.ts must import the SDK generation functions");
    const decideSrc = readFileSync(join(srcDir, DECIDE), "utf-8");
    assert.match(decideSrc, /\.decide\(/, "decide.ts must call the client's decide()");
  });

  it("adopts the boundary at every known runtime inference site", () => {
    const runUsers = [
      "engine.ts", "router.ts", "subagent.ts", "heartbeat.ts", "setup.ts", "operator-daemon.ts",
      "inference/model-role-router.ts", "intelligence/momentum-explainer.ts",
      "intelligence/momentum-evaluator.ts", "watch-intent.ts",
    ];
    for (const rel of runUsers) {
      assert.ok(existsSync(join(srcDir, rel)), `${rel} must exist`);
      assert.ok(valueImports(rel).includes(BOUNDARY), `${rel} must import ${BOUNDARY}`);
    }
    for (const rel of ["decision-relay.ts", "evidence-verifier.ts", "routing/capability-router.ts"]) {
      assert.ok(valueImports(rel).includes(DECIDE), `${rel} must import ${DECIDE}`);
    }
  });

  it("keeps the decide path free of the SDK, engine, MCP, memory and providers", () => {
    assert.ok(existsSync(join(srcDir, DECIDE)), `${DECIDE} must exist`);
    const seen = new Set();
    const external = new Set();
    const walk = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      for (const dep of valueImports(rel)) {
        if (dep.endsWith(".ts")) walk(dep);
        else if (!dep.startsWith("node:")) external.add(dep);
      }
    };
    walk(DECIDE);
    assert.deepEqual([...external], [], "no package dependency on the decide path");
    for (const rel of seen) {
      assert.ok([DECIDE, "inference/receipt.ts", DECISION_CLIENT].includes(rel), `unexpected decide dependency ${rel}`);
    }
  });
});
