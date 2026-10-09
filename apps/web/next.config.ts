import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The agent stream is Server-Sent Events; gzip buffering would hold events back.
  compress: false,
  poweredByHeader: false,
  agentRules: false,
};

export default config;
