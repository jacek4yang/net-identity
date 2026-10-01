/** Validate AMO text limits before a release reaches Mozilla's submission API. */
function metadataObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`AMO metadata ${field} must be an object`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maximum: number): void {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`AMO metadata ${field} must be a non-empty string`);
  // Django counts Unicode code points, not JavaScript UTF-16 code units or bytes.
  const length = [...value].length;
  if (length > maximum)
    throw new Error(`AMO metadata ${field} has ${length} characters; maximum is ${maximum}`);
}

export function assertAmoMetadata(value: unknown): void {
  const metadata = metadataObject(value, "root");
  const summary = metadataObject(metadata.summary, "summary");
  boundedText(summary["en-US"], "summary.en-US", 250);
  for (const [locale, text] of Object.entries(summary)) boundedText(text, `summary.${locale}`, 250);
  const version = metadataObject(metadata.version, "version");
  boundedText(version.approval_notes, "version.approval_notes", 3000);
}
