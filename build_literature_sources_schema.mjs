import { readFileSync } from "node:fs";

const schemaFile = new URL("./literature_sources.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
const sourceType = schema.properties.source_type;
const vocabularyFile = new URL(sourceType["x-civita-vocabulary"], schemaFile);
const vocabulary = JSON.parse(readFileSync(vocabularyFile, "utf8"));

if (!Array.isArray(vocabulary.terms) || vocabulary.terms.length === 0) {
  throw new Error("The source types vocabulary must contain a nonempty terms array.");
}

const terms = vocabulary.terms.map((entry) => entry?.term);
if (terms.some((term) => typeof term !== "string" || term.trim() === "")) {
  throw new Error("Each source type must be a nonempty string.");
}
if (new Set(terms).size !== terms.length) {
  throw new Error("The source types vocabulary contains duplicate terms.");
}

// Emit standard JSON Schema keywords for validators that reject custom annotations.
delete schema.metadata;
delete sourceType["x-civita-vocabulary"];
sourceType.enum = terms;
process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
