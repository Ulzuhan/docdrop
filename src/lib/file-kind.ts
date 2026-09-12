/** A rough family for a file, from its MIME type and extension. Drives the icon and its colour. */
export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "archive"
  | "document"
  | "sheet"
  | "slides"
  | "code"
  | "encrypted"
  | "file";

const ARCHIVES = new Set(["zip", "gz", "tgz", "tar", "rar", "7z", "xz", "zst", "bz2", "dmg", "iso"]);
const DOCUMENTS = new Set(["doc", "docx", "odt", "rtf", "pages", "txt", "md", "epub"]);
const SHEETS = new Set(["xls", "xlsx", "ods", "csv", "numbers", "tsv"]);
const SLIDES = new Set(["ppt", "pptx", "odp", "key"]);
const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cs",
  "rb", "php", "sh", "json", "yml", "yaml", "toml", "xml", "html", "css", "sql",
]);

export function fileKind(mimeType: string, name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (ARCHIVES.has(ext) || mime.includes("zip") || mime.includes("compressed")) return "archive";
  if (SHEETS.has(ext) || mime.includes("spreadsheet")) return "sheet";
  if (SLIDES.has(ext) || mime.includes("presentation")) return "slides";
  if (DOCUMENTS.has(ext) || mime.startsWith("text/") || mime.includes("word")) return "document";
  if (CODE.has(ext)) return "code";
  return "file";
}

export const KIND_LABEL: Record<FileKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  archive: "Archive",
  document: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  code: "Code",
  encrypted: "Encrypted",
  file: "File",
};
