export default function CoachPage() {
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Coach
      </h1>
      <div
        className="rounded-xl border p-6 text-sm"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <p style={{ color: "var(--ink-2)" }}>
          Coming in the next milestone: chat with an AI that can query your
          actual data — trends, sleep, habits and journal — plus an automatic
          weekly report.
        </p>
      </div>
    </main>
  );
}
