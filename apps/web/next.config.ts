import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The agent stream is Server-Sent Events; gzip buffering would hold events back.
  compress: false,
  poweredByHeader: false,
  agentRules: false,
  // Hosted as one container: the public origin also serves the Recourse API (PayPal
  // redirects, webhooks, the public log, x402 /verify and /settle) and the demo publishers.
  async rewrites() {
    const facilitator = process.env.RECOURSE_FACILITATOR_URL ?? "http://127.0.0.1:4020";
    const publishers = (process.env.RECOURSE_CATALOG_URL ?? "http://127.0.0.1:4030/catalog").replace(/\/catalog$/, "");
    return [
      { source: "/recourse/:path*", destination: `${facilitator}/:path*` },
      { source: "/publishers/:path*", destination: `${publishers}/:path*` },
    ];
  },
};

export default config;
