/**
 * CeloTasker — Server-only environment access.
 *
 * Central choke point for reading secret/server env vars. Guarantees:
 * - Values are only reachable from server code (assertServerOnly).
 * - Missing required values fail fast with a clear error, not silently.
 * - No secret value is ever returned to client code by any API route,
 *   because routes never re-export env values.
 */
import { assertServerOnly } from "./SecurityPolicy.ts";

/**
 * Read a server-only env var. Throws if missing/empty so misconfiguration
 * is caught at first use instead of leaking undefined into logic.
 */
export function requireServerEnv(name: string): string {
  assertServerOnly();
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required server environment variable: ${name}. ` +
        `Copy .env.example to .env and fill in real values.`
    );
  }
  return value;
}

/** Read an optional server-only env var with a default. */
export function optionalServerEnv(name: string, fallback = ""): string {
  assertServerOnly();
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}
