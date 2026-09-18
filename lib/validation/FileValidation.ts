/**
 * CeloTasker — Reusable file-upload metadata validation.
 *
 * Validates file METADATA ONLY (name, size, MIME type). No storage or upload
 * system exists yet; the submission system will call this before accepting
 * any file. Reject dangerous extensions regardless of claimed MIME type to
 * prevent stored XSS / code-upload vectors.
 */
import { UPLOAD_POLICY } from "../security/SecurityPolicy.ts";

export interface FileMetadataInput {
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

export type FileValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

export function validateFileMetadata(input: FileMetadataInput): FileValidationResult {
  const { filename, sizeBytes, mimeType } = input;

  if (typeof filename !== "string" || filename.length === 0) {
    return { ok: false, reason: "Filename is required" };
  }
  if (filename.length > UPLOAD_POLICY.MAX_FILENAME_LENGTH) {
    return { ok: false, reason: "Filename too long" };
  }
  // Control characters / path traversal in filenames are rejected outright.
  if (/[\0\r\n\\/\:*?"<>|]/.test(filename) || filename.includes("..")) {
    return { ok: false, reason: "Filename contains forbidden characters" };
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: "Invalid file size" };
  }
  if (sizeBytes > UPLOAD_POLICY.MAX_FILE_BYTES) {
    return { ok: false, reason: `File exceeds maximum size of ${UPLOAD_POLICY.MAX_FILE_BYTES} bytes` };
  }

  const ext = extensionOf(filename);
  if (UPLOAD_POLICY.BLOCKED_EXTENSIONS.includes(ext as never)) {
    return { ok: false, reason: `File extension ${ext} is not allowed` };
  }
  if (!UPLOAD_POLICY.ALLOWED_EXTENSIONS.includes(ext as never)) {
    return { ok: false, reason: `File extension ${ext} is not on the allowlist` };
  }

  if (typeof mimeType !== "string" || !UPLOAD_POLICY.ALLOWED_MIME_TYPES.includes(mimeType as never)) {
    return { ok: false, reason: `MIME type ${mimeType} is not on the allowlist` };
  }

  return { ok: true };
}
