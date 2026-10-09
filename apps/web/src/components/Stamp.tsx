import { Icon, type IconName } from "./Icon";

export type StampKind =
  | "verified"
  | "refunded"
  | "partial"
  | "quarantined"
  | "blocked"
  | "refused"
  | "rejected"
  | "contested"
  | "settled"
  | "pending"
  | "paid"
  | "cancelled"
  | "invalid"
  | "error";

const STAMPS: Record<StampKind, { label: string; tone: "mint" | "butter" | "rose" | "sky" | "plain"; icon: IconName }> = {
  verified: { label: "Verified", tone: "mint", icon: "check" },
  refunded: { label: "Refunded", tone: "sky", icon: "refund" },
  partial: { label: "Partial refund", tone: "sky", icon: "refund" },
  quarantined: { label: "Quarantined", tone: "rose", icon: "alert" },
  blocked: { label: "Blocked by mandate", tone: "butter", icon: "stop" },
  refused: { label: "Refused before charge", tone: "butter", icon: "stop" },
  rejected: { label: "Claim rejected", tone: "mint", icon: "shield" },
  contested: { label: "Contested", tone: "butter", icon: "clock" },
  settled: { label: "Settled", tone: "plain", icon: "check" },
  pending: { label: "Pending", tone: "butter", icon: "clock" },
  paid: { label: "Paid out", tone: "mint", icon: "check" },
  cancelled: { label: "Cancelled", tone: "plain", icon: "cross" },
  invalid: { label: "Invalid", tone: "rose", icon: "cross" },
  error: { label: "Error", tone: "rose", icon: "alert" },
};

export function Stamp({
  kind,
  large,
  flat,
  animate,
  tilt,
  label,
}: {
  kind: StampKind;
  large?: boolean;
  flat?: boolean;
  animate?: boolean;
  tilt?: number;
  label?: string;
}) {
  const s = STAMPS[kind];
  return (
    <span
      className={`stamp stamp--${s.tone}${large ? " stamp--lg" : ""}${flat ? " stamp--flat" : ""}${animate ? " stamp--in" : ""}`}
      style={tilt !== undefined ? ({ "--tilt": `${tilt}deg` } as React.CSSProperties) : undefined}
    >
      <Icon name={s.icon} size={14} />
      {label ?? s.label}
    </span>
  );
}

export const stampLabel = (k: StampKind) => STAMPS[k].label;
