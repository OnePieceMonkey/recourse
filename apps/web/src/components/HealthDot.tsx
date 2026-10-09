"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";

export function HealthDot() {
  const [state, setState] = useState<{ up: boolean; paypal?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = () =>
      getJson<{ ok: boolean; paypal?: string }>("health")
        .then((h) => alive && setState({ up: !!h.ok, ...(h.paypal ? { paypal: h.paypal } : {}) }))
        .catch(() => alive && setState({ up: false }));
    void ping();
    const id = setInterval(ping, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!state) return <span className="health" aria-hidden="true" />;
  return (
    <span className={`health ${state.up ? "health--up" : "health--down"}`} role="status">
      <span className="health__dot" aria-hidden="true" />
      {state.up ? `Facilitator online${state.paypal ? `, PayPal ${state.paypal}` : ""}` : "Facilitator not reachable"}
    </span>
  );
}
