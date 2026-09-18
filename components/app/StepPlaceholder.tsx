/**
 * CeloTasker — honest placeholder for a surface that is not built yet.
 *
 * Used only by the Step 1 shell so navigation has real destinations. It states
 * what the surface will hold and that it does not exist yet — it never shows
 * fabricated tasks, statistics or activity.
 */
export function StepPlaceholder({
  title,
  purpose,
  step,
}: {
  title: string;
  purpose: string;
  step: string;
}) {
  return (
    <section className="max-w-[560px]">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{purpose}</p>
      <p className="mt-5 border-l-2 border-line-strong pl-3.5 text-[13px] leading-relaxed text-ink-faint">
        Not built yet. This surface is added in {step}; until then it stays empty
        rather than showing placeholder data.
      </p>
    </section>
  );
}