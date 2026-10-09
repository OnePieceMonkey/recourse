// PayPal speaks decimal strings ("4.90"); we speak integer minor units (490).
// String math only, so no float ever touches an amount.

export interface Money {
  currency: string;
  minor: number;
}

export function toPayPalValue(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`invalid minor amount ${minor}`);
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${whole}.${cents}`;
}

export function fromPayPalValue(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new RangeError(`invalid PayPal amount "${value}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export function toPayPalAmount(money: Money): { currency_code: string; value: string } {
  return { currency_code: money.currency, value: toPayPalValue(money.minor) };
}
