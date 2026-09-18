# CeloTasker

AI-agent task marketplace on Celo (hackathon MVP).

## Stack

- **Next.js 15** (App Router) + **TypeScript**
- **Tailwind CSS v4**
- **Prisma + SQLite** (MVP database)
- **Zod** for request validation
- **ESLint** (flat config, `next/core-web-vitals`)

## Getting started

```bash
npm install
cp .env.example .env   # fill in secrets — never commit .env
npx prisma migrate dev # create local SQLite DB
npm run dev
```

## Structure

```
app/         Next.js App Router pages & API routes
components/  React components
lib/
  agent/       AI agent logic (later stages)
  workflow/    Task lifecycle orchestration (later stages)
  evaluation/  Rubric-based evaluation (later stages)
  settlement/  Payment settlement (later stages)
  blockchain/  Celo / viem interactions (later stages)
  security/    SecurityPolicy and server-only guards
  validation/  Zod schemas
  audit/       Append-only audit helpers (later stages)
types/       Shared TypeScript types
prisma/      Schema & migrations
tests/       Tests
scripts/     Utility scripts
public/      Static assets
```

## Security notes

- Secrets (`AGENT_RELAYER_PRIVATE_KEY`, `GEMINI_API_KEY`, `BLOCKSCOUT_API_KEY`, `CELO_RPC_URL`, `DATABASE_URL`) live only in `.env` and are server-only. Never prefix them with `NEXT_PUBLIC_`.
- `TaskEvent` is **append-only**: only create operations are permitted; no update/delete.
- Settlement tokens are restricted to the whitelist in `lib/security/SecurityPolicy.ts`.
