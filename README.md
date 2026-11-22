# CIVITA Common Specifications

## JSON filename convention

- Use lowercase letters and underscores in CIVITA JSON filenames, omitting the `civita_` prefix.
- Use `.schema.json` for formal JSON Schema documents, such as [the metadata schema](metadata.schema.json).
- Use `.json` for other specifications, including database hierarchies, controlled vocabularies, and scientific libraries.
- Retain the `civita` namespace in globally unique metadata identifiers, such as `civita.experimental.database_hierarchy`.
- Keep existing filenames that already follow this convention. All new specification files must follow it.

## Literature sources

The [literature sources schema](literature_sources.schema.json) and [source types vocabulary](source_types.json) are shared by the CIVITA Experimental and Computational Databases. Each database assigns its own `source_id` values in the `SRC0001` format. A matching ID in the other database does not establish that two records describe the same publication. Record `authors` as a single string in publication order.

### Validate literature source records

The `x-civita-vocabulary` annotation on `source_type` names the vocabulary file relative to the schema file. Run [the schema generator](build_literature_sources_schema.mjs) with Node.js before dataset validation. It reads the `term` values from that file and emits a Draft 2020-12 validation schema with an `enum` for `source_type`. Use the generated schema to validate every record in the dataset's `literature_sources` collection. An unknown `source_type` fails validation.

To validate one record with Node.js and PowerShell 7.5 or later, run these commands from the repository root:

```powershell
$schema = node ./build_literature_sources_schema.mjs | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not build the literature sources schema' }
if (-not (Test-Json -LiteralPath ./literature_source.json -Schema $schema)) {
    throw 'Invalid literature source record'
}
```
