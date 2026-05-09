export type GitValidationResult =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: string;
    };

export class GitRefValidationError extends Error {
  readonly reason: string;
  readonly value: string;

  constructor(value: string, reason: string) {
    super(`invalid git ref "${value}": ${reason}`);
    this.name = "GitRefValidationError";
    this.reason = reason;
    this.value = value;
  }
}

const MAX_REF_LENGTH = 255;
const DISALLOWED_REF_CHARS = /[\s~^:?*[\]\\]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const SAFE_SEGMENT_CHARS = /[^a-z0-9._-]+/g;
const SAFE_REF_CHARS = /^[A-Za-z0-9._/-]+$/;

export const validateBranchName = (value: string): GitValidationResult => {
  const ref = value.trim();
  const baseValidation = validateSafeRefSyntax(value);
  if (!baseValidation.ok) return baseValidation;
  if (ref === "HEAD") return invalid("HEAD is not a branch name");
  if (ref.startsWith("refs/")) return invalid("branch name must not include refs/ prefix");
  return validateRefPathParts(ref);
};

export const assertValidBranchName = (value: string): string => {
  const result = validateBranchName(value);
  if (!result.ok) throw new GitRefValidationError(value, result.reason);
  return result.value;
};

export const validateGitRef = (value: string): GitValidationResult => {
  const ref = value.trim();
  const baseValidation = validateSafeRefSyntax(value);
  if (!baseValidation.ok) return baseValidation;
  if (ref === "HEAD") return { ok: true, value: ref };
  if (SHA_PATTERN.test(ref)) return { ok: true, value: ref };
  if (ref.startsWith("refs/")) {
    if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) {
      return invalid("only refs/heads/* and refs/tags/* refs are allowed");
    }
  }
  return validateRefPathParts(ref);
};

export const assertValidGitRef = (value: string): string => {
  const result = validateGitRef(value);
  if (!result.ok) throw new GitRefValidationError(value, result.reason);
  return result.value;
};

export const isValidBranchName = (value: string): boolean => validateBranchName(value).ok;

export const isValidGitRef = (value: string): boolean => validateGitRef(value).ok;

export const toBranchSegment = (
  value: string,
  fallback: string,
  options: { maxLength?: number } = {},
): string => {
  const maxLength = Math.max(1, options.maxLength ?? 48);
  const asciiValue = Array.from(value.normalize("NFKD"))
    .filter((char) => char.charCodeAt(0) <= 0x7f)
    .join("");
  const normalized = asciiValue
    .toLowerCase()
    .trim()
    .replace(/@{/g, "_")
    .replace(SAFE_SEGMENT_CHARS, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/_{2,}/g, "_");
  return finalizeBranchSegment(normalized, fallback, maxLength);
};

export const buildBranchName = (segments: string[]): string => {
  const branch = segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return assertValidBranchName(branch);
};

export const timestampBranchSegment = (date = new Date()): string =>
  date.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "z");

const validateSafeRefSyntax = (value: string): GitValidationResult => {
  if (typeof value !== "string") return invalid("ref must be a string");
  const ref = value.trim();
  if (!ref) return invalid("ref is required");
  if (ref !== value) return invalid("ref must not have leading or trailing whitespace");
  if (ref.length > MAX_REF_LENGTH) return invalid(`ref must be at most ${MAX_REF_LENGTH} characters`);
  if (CONTROL_CHARS.test(ref)) return invalid("ref must not contain control characters");
  if (DISALLOWED_REF_CHARS.test(ref)) return invalid("ref contains unsupported characters");
  if (!SAFE_REF_CHARS.test(ref)) return invalid("ref must contain only letters, numbers, '.', '_', '-', and '/'");
  if (ref.startsWith("-")) return invalid("ref must not start with '-'");
  if (ref.startsWith("/")) return invalid("ref must not start with '/'");
  if (ref.endsWith("/")) return invalid("ref must not end with '/'");
  if (ref.includes("//")) return invalid("ref must not contain empty path segments");
  if (ref.includes("..")) return invalid("ref must not contain '..'");
  if (ref.includes("@{")) return invalid("ref must not contain '@{'");
  if (ref === "@") return invalid("ref must not be '@'");
  if (ref.endsWith(".")) return invalid("ref must not end with '.'");
  return { ok: true, value: ref };
};

const validateRefPathParts = (ref: string): GitValidationResult => {
  for (const part of ref.split("/")) {
    if (!part) return invalid("ref must not contain empty path segments");
    if (part.startsWith(".")) return invalid("path segments must not start with '.'");
    if (part.endsWith(".lock")) return invalid("path segments must not end with '.lock'");
  }
  return { ok: true, value: ref };
};

const finalizeBranchSegment = (value: string, fallback: string, maxLength: number): string => {
  const fallbackSegment = fallback.toLowerCase().replace(SAFE_SEGMENT_CHARS, "_") || "branch";
  let cleaned = value.slice(0, maxLength).replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  if (!cleaned) cleaned = fallbackSegment;
  if (cleaned === "@") cleaned = fallbackSegment;
  if (cleaned.endsWith(".lock")) cleaned = `${cleaned.slice(0, -5)}_lock`;
  if (cleaned.startsWith(".")) cleaned = `${fallbackSegment}_${cleaned.slice(1)}`;
  return cleaned || fallbackSegment;
};

const invalid = (reason: string): GitValidationResult => ({ ok: false, reason });
