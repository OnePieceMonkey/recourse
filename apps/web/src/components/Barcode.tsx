// Decorative barcode derived from a hash, so the receipt looks like one and differs per run.
export function Barcode({ seed }: { seed: string }) {
  const hex = (seed || "recourse").replace(/[^0-9a-f]/gi, "0").padEnd(48, "a1").slice(0, 48);
  const bars = [...hex].map((c, i) => {
    const n = parseInt(c, 16);
    return { w: 1 + (n % 4), gap: i % 3 === 0 };
  });
  return (
    <div className="barcode" aria-hidden="true">
      {bars.map((b, i) => (
        <i key={i} style={{ width: b.w * 2, marginRight: b.gap ? 2 : 0 }} />
      ))}
    </div>
  );
}
