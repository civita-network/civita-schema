# CIVITA Common Specifications

## JSON filename convention

- Use lowercase letters and underscores in CIVITA JSON filenames, omitting the `civita_` prefix.
- Use `.schema.json` for formal JSON Schema documents, such as [the metadata schema](metadata.schema.json).
- Use `.json` for other specifications, including database hierarchies, controlled vocabularies, and scientific libraries.
- Retain the `civita` namespace in globally unique metadata identifiers, such as `civita.experimental.database_hierarchy`.
- Keep existing filenames that already follow this convention. All new specification files must follow it.
