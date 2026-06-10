// pdf-parse ships types for its package entry but not the inner module path we
// import to avoid the index file's run-as-main debug branch.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    info: unknown;
    metadata: unknown;
    numpages: number;
    numrender: number;
    text: string;
    version: string;
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdfParse;
}
