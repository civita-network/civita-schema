#!/usr/bin/env node
// Validate the authoritative CIVITA Geometry Library.
//
// Usage (from the civita-schema root):
//   node scripts/validate_geometry_library.mjs [--strict] [library.json]
//
// Stages:
//   1. structural  JSON Schema Draft 2020-12 validation against
//                  geometry_library.schema.json (requires Ajv and ajv-formats)
//   2. semantic    internal consistency checks and expression parsing
//   3. figures     SVG, PDF, TikZ source, and shared style files
//
// Dependencies are located through normal module resolution or CIVITA_AJV_DIR.
// If either is unavailable, the structural stage is reported as SKIPPED.
// With --strict a skipped stage makes the command fail.
// Exit status: 0 if no executed stage failed, 1 otherwise.

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  REPOSITORY_ROOT,
  loadAjv,
  compileLibrarySchema,
  validateLibraryStructure,
  validateLibrarySemantics,
  checkFigureReferences,
} from "./geometry_library_validation.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const fileArgument = args.find((a) => !a.startsWith("--"));
const libraryPath = path.resolve(REPOSITORY_ROOT, fileArgument ?? "geometry_library.json");

const results = [];
const report = (stage, status, detail, errors = []) => {
  results.push({ stage, status });
  console.log(`[${status}] ${stage}${detail ? ` - ${detail}` : ""}`);
  for (const error of errors) console.log(`    ${error.message}`);
};

let library;
try {
  library = JSON.parse(readFileSync(libraryPath, "utf8"));
  report("parse", "PASSED", path.relative(REPOSITORY_ROOT, libraryPath) || libraryPath);
} catch (error) {
  report("parse", "FAILED", `${libraryPath}: ${error.message}`);
  process.exit(1);
}

const ajv = await loadAjv();
if (ajv.unavailable) {
  report("structural", "SKIPPED", ajv.unavailable);
} else {
  try {
    const compiled = compileLibrarySchema(ajv);
    const { valid, errors } = validateLibraryStructure(compiled, library);
    report("structural", valid ? "PASSED" : "FAILED", `geometry_library.schema.json via ${ajv.source}`, errors);
  } catch (error) {
    report("structural", "FAILED", `schema compilation failed: ${error.message}`);
  }
}

const semantic = validateLibrarySemantics(library);
const geometryCount = Object.keys(library.geometries ?? {}).length;
report("semantic", semantic.valid ? "PASSED" : "FAILED", `${geometryCount} geometry definitions`, semantic.errors);

try {
  const figures = checkFigureReferences(library);
  report("figures", figures.valid ? "PASSED" : "FAILED", `${figures.checked.length} files checked`, figures.errors);
} catch (error) {
  report("figures", "FAILED", error.message);
}

const failed = results.some((r) => r.status === "FAILED") || (strict && results.some((r) => r.status === "SKIPPED"));
console.log(failed ? "Geometry Library validation FAILED." : `Geometry Library validation completed${results.some((r) => r.status === "SKIPPED") ? " with skipped stages" : ""}.`);
process.exit(failed ? 1 : 0);
