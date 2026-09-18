"use client";

/**
 * CeloTasker — payment stage (Approve & Relay).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Two strictly separated actions:
 * - REQUESTER authorization: the requester's own wallet signs exactly ONE
 *   ERC-20 approve(spender, reward) on the mainnet cUSD contract, granting
 *   the platform relayer the right to move the task reward. An approval is
 *   AUTHORIZATION ONLY — it never transfers cUSD and never calls
 *   /api/settlements.
 * - WORKER release: the assigned worker alone triggers POST /api/settlements
 *   with { submissionId }. The server-side relayer (whose private key never
 *   reaches the browser) broadcasts transferFrom(requester → worker) and
 *   verifies the receipt. The worker never signs an on-chain transaction.
 *
 * Every displayed fact — allowance, transaction hash, settlement status —
 * comes from Celo or from the backend response. Nothing is fabricated here.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseUnits,
} from "viem";
import { celo } from "viem/chains";
import { apiFetch, ApiError } from "@/lib/api/client";
import { CUSD_ADDRESS, CELO_CHAIN_ID, PUBLIC_RPC_URL } from "@/lib/celo";
import { CELO_CHAIN_ID_HEX, ensureCeloChain, getInjectedProvider } from "@/lib/wallet/eip1193";
import { useWallet } from "@/components/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";
import type { SettlementJson, TaskStateJson } from "./RequesterReview";
import type { TaskResponse } from "./TaskList";

/** GET /api/relayer — public spender facts; the client never guesses them. */
type RelayerInfo = { relayerAddress: string; chainId: number; token: string };

/** POST /api/settlements `transaction` (SettlementExecutor.TransactionInfo). */
type SettlementTransaction = {
  txHash: string;
  status: string;
  chainId: number;
  blockNumber: number | null;
};

/** POST /api/settlements response body: { settlement, eligible, transaction, note }. */
type SettlementResponse = {
  settlement: SettlementJson;
  eligible?: boolean;
  transaction: SettlementTransaction | null;
  note: string | null;
};

/** Read-only viem client over the whitelisted public RPC (wallet's pattern). */
function celoClient() {
  return createPublicClient({ chain: celo, transport: http(PUBLIC_RPC_URL) });
}

/** Integer-only base-unit formatting: BigInt division, never floating point. */
function formatBaseUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

/** Plain definition list row (label left, value right), mobile-friendly. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

/** A wallet/backend transaction hash, linked to the Celo explorer. */
function TxHashRow({ txHash, label }: { txHash: string; label: string }) {
  return (
    <div className="mt-3">
      <TxRow label={label}>
        <a
          href={`https://celoscan.io/tx/${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="text-celo hover:underline"
        >
          {txHash}
        </a>
      </TxRow>
    </div>
  );
}

function actionError(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && caught.status === 401) {
    return "Your session has expired. Reconnect your wallet, then try again.";
  }
  return caught instanceof Error ? caught.message : fallback;
}

function TxRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="min-w-0 break-all text-right">{children}</span>
    </div>
  );
}

/**
 * Transaction facts (Part E). Rendered ONLY when a real hash was returned by
 * the wallet or the backend — never invented, never a fake explorer link.
 */
function TransactionDetails({ transaction, reward, recipient }: {
  transaction: SettlementTransaction;
  reward: string;
  recipient: string;
}) {
  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <TxRow label="Transaction">
        <a
          href={`https://celoscan.io/tx/${transaction.txHash}`}
          target="_blank"
          rel="noreferrer"
          className="text-celo hover:underline"
        >
          {transaction.txHash}
        </a>
      </TxRow>
      <TxRow label="Network">
        <span className="font-mono text-xs">Celo Mainnet ({transaction.chainId})</span>
      </TxRow>
      <TxRow label="Amount">
        <span>{reward}</span>
      </TxRow>
      <TxRow label="Recipient (worker)">
        <span className="font-mono text-xs">{recipient}</span>
      </TxRow>
      <TxRow label="On-chain status">
        <span className="font-mono text-xs">{transaction.status}</span>
      </TxRow>
    </div>
  );
}

/** Settlement progression, in the order the backend actually executes it. */
const STAGES = [
  "Settlement requested",
  "Broadcasting",
  "Confirming on Celo",
  "Transfer verified",
  "Settled",
] as const;

/**
 * Stage derived ONLY from backend facts — row status, transaction status and
 * note. Never from timing, optimism or client-side guessing.
 */
function settlementStage(
  settlement: SettlementJson,
  transaction: SettlementTransaction | null,
  note: string | null
): number {
  if (settlement.status === "CONFIRMED") return STAGES.length - 1; // Settled
  if (settlement.status === "FAILED") return -1; // Payment failed
  if (transaction?.status === "CONFIRMED") return STAGES.length - 2; // Transfer verified
  if (transaction?.txHash) return STAGES.length - 3; // Confirming on Celo
  if (note && note.startsWith("awaiting_confirm")) return STAGES.length - 3;
  return 0; // Settlement requested (or an unresolved broadcast being recovered)
}

/**
 * Requester cUSD authorization (Parts A/B/G).
 *
 * Reads the real on-chain allowance(requester → relayer) and token decimals
 * from the mainnet cUSD contract, compares it against the task reward parsed
 * with integer-only string parsing, and — only when insufficient — asks the
 * requester's wallet to sign exactly ONE approve(relayer, reward). The
 * wallet stays on the existing provider; ensureCeloChain() verifies Celo
 * Mainnet (42220) before anything is broadcast. An approval is authorization
 * only: it never calls /api/settlements and never moves cUSD.
 */
function RequesterAllowance({ task, approved, authorizeReady, onRefresh }: {
  task: TaskResponse;
  approved: boolean;
  /** True only while the backend still awaits settlement (UNDER_REVIEW). */
  authorizeReady: boolean;
  onRefresh: () => void;
}) {
  const wallet = useWallet();
  const sessionAddress = wallet.sessionAddress;
  const [relayer, setRelayer] = useState<RelayerInfo | null>(null);
  const [relayerError, setRelayerError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [required, setRequired] = useState<bigint | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "sending" | "confirming">("idle");
  const [approvalTx, setApprovalTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);

  // The spender address comes from the backend — never guessed client-side.
  useEffect(() => {
    let active = true;
    apiFetch<RelayerInfo>("/api/relayer", { method: "GET", cache: "no-store" })
      .then((info) => {
        if (!active) return;
        setRelayer(info);
        setRelayerError(null);
      })
      .catch((caught) => {
        if (!active) return;
        setRelayer(null);
        setRelayerError(
          caught instanceof Error ? caught.message : "The payment relayer is not available."
        );
      });
    return () => { active = false; };
  }, []);

  async function readOnChain(owner: string, spender: string) {
    const client = celoClient();
    const [tokenDecimals, currentAllowance] = await Promise.all([
      client.readContract({ address: CUSD_ADDRESS, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({
        address: CUSD_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner as `0x${string}`, spender as `0x${string}`],
      }),
    ]);
    return { decimals: tokenDecimals, allowance: currentAllowance };
  }

  // allowance(requester, relayer) + token decimals, read from Celo Mainnet.
  useEffect(() => {
    if (!relayer || !approved) return;
    let active = true;
    setReadError(null);
    (async () => {
      try {
        if (!isAddress(task.creator) || !isAddress(relayer.relayerAddress)) {
          throw new Error("invalid address");
        }
        const read = await readOnChain(task.creator, relayer.relayerAddress);
        if (!active) return;
        setAllowance(read.allowance);
        // Whole-cUSD string → base units via viem's integer string parser.
        setRequired(parseUnits(task.rewardAmount.trim(), read.decimals));
      } catch {
        if (active) setReadError("Could not read the cUSD allowance from Celo Mainnet.");
      }
    })();
    return () => { active = false; };
  }, [relayer, approved, task.creator, task.rewardAmount, attempt]);

  /** ONE approve(relayer, reward) — signed by the requester's own wallet. */
  async function authorize() {
    if (running.current || !relayer || !sessionAddress || required === null) return;
    setError(null);
    setApprovalTx(null);
    running.current = true;
    setPhase("sending");
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No connected wallet was found. Connect your wallet using the header.");
      // Broadcast only on Celo Mainnet, from the authenticated session address.
      const chainId = await ensureCeloChain(provider);
      if (chainId !== CELO_CHAIN_ID) {
        throw new Error(`The wallet is not on Celo Mainnet (chain id ${chainId}).`);
      }
      if (task.creator.toLowerCase() !== sessionAddress.toLowerCase()) {
        throw new Error("Only the requester can authorize payment for this task.");
      }
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [relayer.relayerAddress as `0x${string}`, required],
      });
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: sessionAddress,
          to: CUSD_ADDRESS,
          data,
          chainId: CELO_CHAIN_ID_HEX,
        }],
      }) as string;
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error("The wallet did not return a transaction hash.");
      }
      setApprovalTx(txHash);
      setPhase("confirming");
      // Wait for the receipt; only then treat the allowance as updated.
      const receipt = await celoClient().waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      if (receipt.status !== "success") {
        throw new Error("The approval transaction did not succeed on Celo.");
      }
      setPhase("idle");
      // Authoritative refetch: state bundle + fresh on-chain allowance.
      onRefresh();
      setAttempt((value) => value + 1);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The cUSD payment could not be authorized."
      );
      setPhase("idle");
    } finally {
      running.current = false;
    }
  }

  const sufficient = allowance !== null && required !== null && allowance >= required;
  const busy = phase !== "idle";

  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Payment authorization</h3>
      <dl className="mt-4 space-y-5 text-sm">
        <Row label="Reward">{task.rewardAmount} cUSD</Row>
        <Row label="Approved spender">
          {relayer ? (
            <span className="break-all font-mono text-xs leading-relaxed">{relayer.relayerAddress}</span>
          ) : relayerError ? (
            <span className="text-fail">{relayerError}</span>
          ) : (
            <span className="text-ink-soft">Loading…</span>
          )}
        </Row>
        <Row label="Allowance for this reward">
          {allowance === null || required === null ? (
            readError ? <span className="text-fail">{readError}</span> : <span className="text-ink-soft">Reading…</span>
          ) : sufficient ? (
            <span>Already authorized for this task.</span>
          ) : (
            <span>Not yet authorized for this task.</span>
          )}
        </Row>
      </dl>

      {readError && (
        <div className="mt-4">
          <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}

      {sufficient ? (
        <p role="status" className="mt-4 text-sm font-medium">cUSD payment authorized</p>
      ) : approved && !readError ? (
        <div className="mt-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            One wallet approval lets the payment relayer collect exactly this reward from your cUSD
            balance when the worker releases payment. It transfers nothing on its own.
          </p>
          {error && <p role="alert" className="mt-3 break-words text-sm text-fail">{error}</p>}
          {phase === "confirming" && (
            <p role="status" className="mt-3 text-sm text-ink-soft">Confirming on Celo…</p>
          )}
          {approvalTx && <TxHashRow txHash={approvalTx} label="Approval transaction" />}
          <div className="mt-4">
            <Button onClick={authorize} disabled={busy || !sessionAddress}>
              {phase === "sending" ? "Approving…" : phase === "confirming" ? "Confirming…" : "Authorize cUSD payment"}
            </Button>
          </div>
        </div>
      ) : null}
      {!authorizeReady && approved && (
        <p className="mt-4 text-sm text-ink-soft">
          The settlement request has already been made. A further authorization is no longer needed.
        </p>
      )}
    </div>
  );
}

/**
 * Worker-triggered settlement (Parts C/D/H): the ONLY caller of
 * /api/settlements. The worker never signs an on-chain transaction; the
 * server-side relayer broadcasts transferFrom(requester → worker) and the
 * displayed progression comes solely from the real response.
 */
function WorkerSettlement({ submissionId, task, settleReady, onRefresh }: {
  submissionId: string;
  task: TaskResponse;
  settleReady: boolean;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SettlementResponse | null>(null);
  const [ineligible, setIneligible] = useState<string | null>(null);
  const running = useRef(false);

  async function release() {
    if (running.current) return;
    setError(null);
    setIneligible(null);
    running.current = true;
    setPending(true);
    try {
      const body = await apiFetch<SettlementResponse | { eligible: false; error: string }>(
        "/api/settlements",
        { method: "POST", cache: "no-store", body: JSON.stringify({ submissionId }) }
      );
      if ("eligible" in body && body.eligible === false) {
        setIneligible("error" in body && body.error ? body.error : "Settlement is not available yet.");
      } else {
        const response = body as SettlementResponse;
        setResult(response);
        if (response.note === "already_settled") {
          setIneligible(null);
        }
      }
      // The authoritative task/submission state moved server-side; refetch it.
      onRefresh();
    } catch (caught) {
      setError(actionError(caught, "Could not request settlement."));
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  const stage = result ? settlementStage(result.settlement, result.transaction, result.note) : null;
  const failed = result?.settlement.status === "FAILED";
  const settled = result?.settlement.status === "CONFIRMED";

  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Payment</h3>
      <dl className="mt-4 space-y-5 text-sm">
        <Row label="Reward ready for you">{task.rewardAmount} cUSD</Row>
        <Row label="Payer (requester)">
          <span className="break-all font-mono text-xs leading-relaxed">{task.creator}</span>
        </Row>
      </dl>
      {settleReady ? (
        <div className="mt-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            Releasing payment tells the platform relayer to transfer the reward from the requester to
            you. You do not sign a transaction; no wallet approval is needed from you.
          </p>
          {error && <p role="alert" className="mt-3 break-words text-sm text-fail">{error}</p>}
          {ineligible && <p role="status" className="mt-3 text-sm text-ink-soft">{ineligible}</p>}
          <div className="mt-4">
            <Button onClick={release} disabled={pending || settled}>
              {pending ? "Releasing…" : settled ? "Payment settled" : "Release payment"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">
          The requester has not authorized the cUSD payment yet. You will be able to release it once
          they do.
        </p>
      )}
      {result && (
        <div className="mt-5">
          {stage !== null && stage >= 0 && (
            <ol className="space-y-2" aria-label="Settlement progress">
              {STAGES.map((label, index) => {
                const reached = index <= stage;
                return (
                  <li key={label} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className={reached ? "" : "text-ink-soft"}>{label}</span>
                    <span className="shrink-0 text-xs text-ink-soft">{reached ? "Done" : "Pending"}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {failed && (
            <p role="alert" className="mt-3 text-sm text-fail">
              Payment failed on Celo. The task was marked PAYMENT_FAILED by the backend.
            </p>
          )}
          {settled && (
            <p role="status" className="mt-3 text-sm font-medium">Settled</p>
          )}
          {result.note && result.note !== "already_settled" && (
            <p className="mt-3 break-words text-sm text-ink-soft">Note from the backend: {result.note}</p>
          )}
          {result.transaction && (
            <TransactionDetails
              transaction={result.transaction}
              reward={`${task.rewardAmount} cUSD`}
              recipient={result.settlement.recipient}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Payment stage gate (Parts A/C/F/G/H). Rendered only once a submission is
 * approved; the requester sees authorization, the worker sees release, and
 * both are driven by the authoritative state/settlement from the backend.
 */
export function PaymentSection({ state, isCreator, isWorker, onRefresh }: {
  state: TaskStateJson;
  isCreator: boolean;
  isWorker: boolean;
  onRefresh: () => void;
}) {
  const wallet = useWallet();
  const { task, submission, settlement } = state;
  if (!submission) return null;

  const workerAlive =
    isWorker &&
    wallet.status === "authenticated" &&
    !!wallet.sessionAddress &&
    task.assignee?.toLowerCase() === wallet.sessionAddress.toLowerCase();

  // Part G: the requester's job is the approval, while the backend can still
  // accept a settlement request (UNDER_REVIEW with an approved submission).
  const authorizeReady = isCreator && task.status === "UNDER_REVIEW";
  // Part H: a settlement row exists — the backend already accepted (or can
  // idempotently resume) the worker's request. Covers SETTLING, a
  // still-UNDER_REVIEW task whose settlement exists, and SETTLED/COMPLETED.
  const settleReady =
    workerAlive &&
    (task.status === "SETTLING" ||
      task.status === "SETTLED" ||
      task.status === "COMPLETED" ||
      task.status === "PAYMENT_FAILED" ||
      settlement !== null);

  if (task.status !== "UNDER_REVIEW" && !settlement && !settleReady && !authorizeReady) {
    return null;
  }

  return (
    <section aria-labelledby="payment-heading" className="mt-8">
      <h2 id="payment-heading" className="text-lg font-medium">Payment</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {isCreator
          ? "Authorize the cUSD payment for this task. The transfer itself happens when the worker releases it."
          : workerAlive
            ? "The requester authorizes the cUSD payment; you release it. The platform relayer performs the transfer."
            : "Payment between the requester and the assigned worker."}
      </p>
      {isCreator && submission.status === "APPROVED" && (
        <RequesterAllowance
          task={task}
          approved
          authorizeReady={authorizeReady}
          onRefresh={onRefresh}
        />
      )}
      {isWorker && submission.status === "APPROVED" && (
        workerAlive && settleReady ? (
          <WorkerSettlement
            submissionId={submission.id}
            task={task}
            settleReady
            onRefresh={onRefresh}
          />
        ) : (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="text-sm font-medium text-ink-soft">Payment</h3>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              The work was approved. Payment becomes available once the requester authorizes the cUSD
              reward.
            </p>
          </div>
        )
      )}
      {settlement && <SettlementNote settlement={settlement} task={task} />}
    </section>
  );
}

/** A persisted settlement row shown read-only for both roles (Part D/F). */
function SettlementNote({ settlement, task }: {
  settlement: SettlementJson;
  task: TaskResponse;
}) {
  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Settlement record</h3>
      <dl className="mt-4 space-y-5 text-sm">
        <Row label="Status">
          <span className="font-mono text-xs">{settlement.status}</span>
        </Row>
        <Row label="Amount">
          {formatBaseUnits(BigInt(settlement.amount), 18)} cUSD
        </Row>
        <Row label="Recipient (worker)">
          <span className="break-all font-mono text-xs leading-relaxed">{settlement.recipient}</span>
        </Row>
        <Row label="Requested">
          <time dateTime={settlement.createdAt}>
            {new Date(settlement.createdAt).toLocaleString()} (your local time)
          </time>
        </Row>
      </dl>
      {settlement.status === "FAILED" && (
        <p role="alert" className="mt-3 text-sm text-fail">
          This settlement failed on Celo. The task is marked PAYMENT_FAILED.
        </p>
      )}
      {settlement.status === "PENDING" && task.status === "SETTLING" && (
        <p role="status" className="mt-3 text-sm text-ink-soft">Settlement is in progress.</p>
      )}
      {settlement.status === "BROADCAST" && (
        <p role="status" className="mt-3 text-sm text-ink-soft">
          The transfer is broadcast and confirming on Celo.
        </p>
      )}
      {settlement.status === "CONFIRMED" && (
        <p role="status" className="mt-3 text-sm font-medium">Settled</p>
      )}
    </div>
  );
}






