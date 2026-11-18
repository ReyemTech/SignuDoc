/** Display text may span lines in a document, but mail subjects occupy one line. */
export function emailSubject(
  parts: TemplateStringsArray,
  ...values: string[]
): string {
  return parts.reduce(
    (subject, part, index) =>
      subject + values[index - 1].replace(/[\r\n]+/g, " ") + part,
  );
}
