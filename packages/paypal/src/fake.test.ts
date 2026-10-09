import { describe, expect, it } from "vitest";
import { FakePayPal, fromPayPalValue, toPayPalValue } from "./index";

describe("money conversion", () => {
  it("formats and parses without floats", () => {
    expect(toPayPalValue(490)).toBe("4.90");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(fromPayPalValue("4.9")).toBe(490);
    expect(fromPayPalValue("0.05")).toBe(5);
    expect(() => fromPayPalValue("1e3")).toThrow();
  });
});

describe("FakePayPal", () => {
  const eur = (minor: number) => ({ currency: "EUR", minor });

  it("charges a vault only after approval and refunds up to the capture", async () => {
    const pp = new FakePayPal();
    const { setupTokenId } = await pp.createVaultSetupToken({ returnUrl: "http://x/ok", cancelUrl: "http://x/no" });
    await expect(pp.createPaymentToken(setupTokenId)).rejects.toThrow(/not approved/);
    pp.approveSetupToken(setupTokenId);
    const { vaultId } = await pp.createPaymentToken(setupTokenId);
    const charge = await pp.chargeVault({ vaultId, amount: eur(190), description: "x", customId: "p1", requestId: "r1" });
    expect(charge.status).toBe("COMPLETED");
    await pp.refundCapture({ captureId: charge.captureId, amount: eur(100), note: "", requestId: "f1" });
    await expect(pp.refundCapture({ captureId: charge.captureId, amount: eur(100), note: "", requestId: "f2" })).rejects.toThrow(
      /exceeds/,
    );
  });

  it("is idempotent per request id", async () => {
    const pp = new FakePayPal();
    const { setupTokenId } = await pp.createVaultSetupToken({ returnUrl: "http://x/ok", cancelUrl: "http://x/no" });
    pp.approveSetupToken(setupTokenId);
    const { vaultId } = await pp.createPaymentToken(setupTokenId);
    const a = await pp.chargeVault({ vaultId, amount: eur(490), description: "x", customId: "p1", requestId: "same" });
    const b = await pp.chargeVault({ vaultId, amount: eur(490), description: "x", customId: "p1", requestId: "same" });
    expect(b.captureId).toBe(a.captureId);
    expect(pp.captures.size).toBe(1);
  });
});
