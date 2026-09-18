/**
 * CeloTasker — Zod schemas for authentication endpoints.
 * Every auth request is validated server-side before any logic runs.
 */
import { z } from "zod";
import { evmAddress } from "./ValidationSchemas.ts";

export const ChallengeRequestSchema = z.object({
  address: evmAddress,
});

export const VerifyRequestSchema = z.object({
  /** The full authentication message exactly as signed. */
  message: z.string().min(20).max(4096),
  /** EIP-191 personal_sign signature: 65-byte r||s||v, hex-encoded. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature format"),
});

export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
