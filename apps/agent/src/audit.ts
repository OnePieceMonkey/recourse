import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";

export interface PayPalCheck {
  refundId: string;
  status: string;
  amount?: { currency_code: string; value: string };
  error?: string;
}

// The agent does not take Recourse's word for a refund: it asks PayPal itself,
// through PayPal's Agent Toolkit, with read-only tools only. Money-moving tools
// are not enabled here, so no model and no code path in the agent can refund,
// capture or accept anything through the toolkit.
export function paypalAuditorFromEnv() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const toolkit = new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: {
      actions: { payments: { getRefunds: true }, orders: { get: true }, disputes: { list: true, get: true } },
      context: { sandbox: true },
    },
  });
  let seq = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    seq += 1;
    const msg = await toolkit.handleToolCall({ id: `audit_${seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return JSON.parse(content) as Record<string, any>;
  };
  return {
    tools: () => toolkit.getTools().map((t) => t.function.name),
    async checkRefund(refundId: string): Promise<PayPalCheck> {
      try {
        const r = await call("get_refund", { refund_id: refundId });
        return { refundId, status: String(r.status ?? "UNKNOWN"), ...(r.amount ? { amount: r.amount } : {}) };
      } catch (e) {
        return { refundId, status: "UNVERIFIED", error: (e as Error).message };
      }
    },
  };
}
