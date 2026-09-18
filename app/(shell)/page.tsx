/**
 * CeloTasker — home (demo-ready landing).
 *
 * States the product, the real seven-stage workflow and the two-sided model.
 * Everything described here is implemented in the product: no invented
 * metrics, testimonials or imagery; links point only at routes that exist.
 */
import Link from "next/link";
import { buttonClasses } from "@/components/ui/buttonClasses";

/** The real product flow, in order. No stage is decorative. */
const FLOW = [
  { name: "Create", line: "The requester structures the request: title, description, rubric, reward." },
  { name: "Claim", line: "A worker claims the open task. First claimant wins; the requester cannot claim their own task." },
  { name: "Submit", line: "The worker submits the work: a public link and one sentence of context." },
  { name: "Validate", line: "Deterministic checks run first: reference format, deadline, rubric coverage." },
  { name: "Review", line: "An AI review reads the submission against the rubric and recommends. It never decides alone." },
  { name: "Confirm", line: "The requester reads the evidence and explicitly authorizes the payment." },
  { name: "Settle", line: "The worker triggers settlement. A relayer executes the cUSD transfer on Celo." },
] as const;

export default function Home() {
  return (
    <article className="max-w-[720px]">
      <section aria-labelledby="hero-heading">
        <p className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-ink-faint">
          AI review advises. The requester authorizes. Celo settles.
        </p>
        <h1
          id="hero-heading"
          className="mt-3 text-[34px] font-semibold leading-[1.12] tracking-[-0.025em] text-ink sm:text-[44px]"
        >
          Turn requests into verified human work.
        </h1>
        <p className="mt-5 max-w-[600px] text-[15.5px] leading-relaxed text-ink-soft">
          CeloTasker coordinates human work that has to prove itself. A
          requester describes the job and its rubric; a worker claims it and
          submits evidence; deterministic checks and an AI review examine the
          submission; and the requester, not the AI, authorizes the payment
          before a cent moves.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/tasks/new" className={buttonClasses("primary", "md")}>
            Create a task
          </Link>
          <Link href="/tasks" className={buttonClasses("secondary", "md")}>
            Find work
          </Link>
        </div>
      </section>

      <section aria-labelledby="how-heading" className="mt-14 border-t border-line pt-8">
        <h2 id="how-heading" className="text-lg font-medium">How it works</h2>
        <ol className="mt-5 divide-y divide-line">
          {FLOW.map((stage, index) => (
            <li
              key={stage.name}
              className="grid gap-1.5 py-4 sm:grid-cols-[3.5rem_9rem_1fr] sm:items-baseline sm:gap-4"
            >
              <span className="font-mono text-[12px] text-ink-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-[14.5px] font-medium text-ink">{stage.name}</span>
              <span className="text-[14px] leading-relaxed text-ink-soft">{stage.line}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="sides-heading" className="mt-12 border-t border-line pt-8">
        <h2 id="sides-heading" className="text-lg font-medium">Two sides, one record</h2>
        <div className="mt-5 grid gap-8 sm:grid-cols-2">
          <div>
            <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-celo">Requester</h3>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Creates the task with a rubric and a cUSD reward. Reviews the
              submitted evidence, the deterministic validation and the AI
              review, then explicitly authorizes payment. The recommendation
              never moves money on its own.
            </p>
          </div>
          <div>
            <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-celo">Worker</h3>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Finds an open task, claims it and submits evidence: a public link
              plus one sentence of context. Once the requester confirms, the
              worker triggers settlement and is paid from the authorized cUSD.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="celo-heading" className="mt-12 border-t border-line pt-8">
        <h2 id="celo-heading" className="text-lg font-medium">Payments on Celo</h2>
        <p className="mt-4 max-w-[640px] text-[14px] leading-relaxed text-ink-soft">
          Rewards are paid in cUSD on Celo Mainnet. The requester grants the
          task an allowance (a standard, reward-sized approval) and the actual
          transfer is executed by a dedicated server-side relayer, so the worker
          is paid without anyone handling keys in the browser. Every payment
          step is recorded in the task&apos;s audit trail.
        </p>
      </section>

      <section aria-labelledby="start-heading" className="mt-12 border-t border-line pt-8">
        <h2 id="start-heading" className="text-lg font-medium">Start somewhere</h2>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link href="/tasks/new" className={buttonClasses("primary", "md")}>
            Create a task
          </Link>
          <Link href="/tasks" className={buttonClasses("secondary", "md")}>
            Find work
          </Link>
        </div>
      </section>
    </article>
  );
}