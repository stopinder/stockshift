// Public flag parsing shared with server validation; defaults never enable hosted PDF.
export function hostedPdfCapabilities(
  env: Record<string, unknown>,
  prefix = "",
) {
  const flag = (name: string) => {
    const value = env[`${prefix}STOCKSHIFT_HOSTED_PDF_${name}_ENABLED`];
    if (value != null && value !== "" && value !== "0" && value !== "1")
      throw new Error("Hosted PDF capability must be 0 or 1");
    return value === "1";
  };
  const inspection = flag("INSPECTION"),
    extraction = flag("EXTRACTION");
  if (extraction && !inspection)
    throw new Error("Digital extraction requires CPU inspection");
  if ((inspection || extraction) && env[`${prefix}STOCKSHIFT_CSV_ONLY`] === "1")
    throw new Error("CSV-only mode conflicts with hosted PDF capabilities");
  if (
    !prefix &&
    env.STOCKSHIFT_OCR_ENABLED &&
    env.STOCKSHIFT_OCR_ENABLED !== "0"
  )
    throw new Error("Hosted CPU PDF capabilities require OCR disabled");
  return { inspection, extraction };
}
