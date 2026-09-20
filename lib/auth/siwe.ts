/**
 * CeloTasker — SIWE-style (EIP-4361) authentication messages.
 *
 * The message format, chain ID and version are frozen here. The application
 * domain/URI are resolved per request (resolveAuthOrigin: Origin header →
 * APP_URL → production origin) and re-validated from the signed
 * message itself at verification time. The server independently re-parses
 * and re-validates every field of whatever the client submits for
 * verification — altered, missing or extra fields are rejected.
 */
import { optionalServerEnv } from "../security/env.ts";

export const AUTH_CHAIN_ID = 42220; // Celo Mainnet
export const AUTH_VERSION = "1";
export const AUTH_STATEMENT =
  "Sign in to CeloTasker. This signature does not transfer funds or grant token approvals.";

/** Fallback application origin when no request origin or configured URL applies. */
export const DEFAULT_APP_ORIGIN = "https://celotasker.vercel.app";

export interface AuthOrigin {
  /** Host with port when present (e.g. "localhost:3000"). */
  domain: string;
  /** Absolute origin (e.g. "https://celotasker.vercel.app"). */
  uri: string;
}

/**
 * Resolve the application origin shown in the challenge message from the
 * incoming request: Origin header first, then APP_URL, then the
 * production origin. A candidate that is not a parseable http(s) origin is
 * ignored, so a hostile Origin header can never inject a bogus domain into
 * an otherwise valid fallback.
 */
export function resolveAuthOrigin(
  originHeader: string | null | undefined
): AuthOrigin {
  const candidates = [
    originHeader,
    optionalServerEnv("APP_URL"),
    DEFAULT_APP_ORIGIN,
  ];
  for (const candidate of candidates) {
    const origin = parseAuthOrigin(candidate);
    if (origin) return origin;
  }
  // Unreachable: DEFAULT_APP_ORIGIN always parses.
  const url = new URL(DEFAULT_APP_ORIGIN);
  return { domain: url.host, uri: url.origin };
}

/** Parse a candidate string into { domain, uri }; null when not http(s). */
function parseAuthOrigin(candidate: string | null | undefined): AuthOrigin | null {
  if (!candidate || candidate.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null; // reject "https://evil@host"
  return { domain: url.host, uri: url.origin };
}

/**
 * Structural consistency of the application binding inside a SIGNED message:
 * the URI must be an absolute http(s) URL without credentials whose host
 * equals the claimed domain. Verification relies on this instead of any
 * hardcoded deployment domain — the domain/URI pair the server issued in the
 * challenge is what the wallet signs, and identity stays bound by the
 * single-use nonce plus signer recovery.
 */
export function isConsistentAuthOrigin(domain: string, uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  return url.host === domain;
}

export interface SiweMessageParams {
  domain: string;
  address: string;
  uri: string;
  nonce: string;
  issuedAt: string; // ISO 8601
  expirationTime: string; // ISO 8601
}

export function buildSiweMessage(p: SiweMessageParams): string {
  return [
    `${p.domain} wants you to sign in with your Celo account:`,
    p.address,
    "",
    AUTH_STATEMENT,
    "",
    `URI: ${p.uri}`,
    `Version: ${AUTH_VERSION}`,
    `Chain ID: ${AUTH_CHAIN_ID}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expirationTime}`,
  ].join("\n");
}

export interface ParsedSiweMessage {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export class MalformedMessageError extends Error {
  constructor(reason: string) {
    super(`Malformed authentication message: ${reason}`);
    this.name = "MalformedMessageError";
  }
}

function field<T>(
  lines: string[],
  prefix: string,
  parse: (v: string) => T | null
): T {
  const line = lines.find((l) => l.startsWith(`${prefix}: `));
  if (!line) throw new MalformedMessageError(`missing field "${prefix}"`);
  const raw = line.slice(prefix.length + 2).trim();
  if (raw === "") throw new MalformedMessageError(`empty field "${prefix}"`);
  const value = parse(raw);
  if (value === null || value === undefined) {
    throw new MalformedMessageError(`invalid value for "${prefix}"`);
  }
  return value;
}

/**
 * Strict parser. Rejects altered structure, missing fields and
 * extra/unexpected header lines. Statement must match exactly — clients
 * never choose the statement.
 */
export function parseSiweMessage(message: string): ParsedSiweMessage {
  const lines = message.split("\n");
  if (lines.length < 8) {
    throw new MalformedMessageError("unexpected line count");
  }

  const header = lines[0];
  const suffix = " wants you to sign in with your Celo account:";
  if (!header.endsWith(suffix) || header.length <= suffix.length) {
    throw new MalformedMessageError("unrecognized header line");
  }
  const domain = header.slice(0, header.length - suffix.length).trim();
  if (domain === "" || /\s/.test(domain)) {
    throw new MalformedMessageError("invalid domain");
  }

  const address = lines[1].trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new MalformedMessageError("invalid address");
  }
  if (lines[2] !== "" || lines[4] !== "") {
    throw new MalformedMessageError("unexpected blank-line structure");
  }

  const statement = lines[3];
  if (statement !== AUTH_STATEMENT) {
    throw new MalformedMessageError("statement does not match");
  }

  const version = field(lines, "Version", (v) => {
    if (!/^\d+$/.test(v)) return null;
    return v;
  });
  const chainId = field(lines, "Chain ID", (v) => {
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  });
  const nonce = field(lines, "Nonce", (v) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(v)) return null;
    return v;
  });
  const uri = field(lines, "URI", (v) => {
    try {
      return new URL(v).toString();
    } catch {
      return null;
    }
  });
  const issuedAt = field(lines, "Issued At", parseIso);
  const expirationTime = field(lines, "Expiration Time", parseIso);

  return {
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  };
}

function parseIso(v: string): string | null {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // Normalize to ISO so comparisons are unambiguous.
  return d.toISOString();
}
