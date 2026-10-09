// Server-only configuration. The admin token never leaves the server: browsers only
// talk to the route handlers under /api, which add it for an allowlisted set of calls.
const trim = (u: string) => u.replace(/\/+$/, "");

export const env = {
  facilitatorUrl: trim(process.env.RECOURSE_FACILITATOR_URL ?? "http://localhost:4020"),
  agentUrl: trim(process.env.RECOURSE_AGENT_URL ?? "http://localhost:4040"),
  catalogUrl: process.env.RECOURSE_CATALOG_URL ?? "http://localhost:4030/catalog",
  adminToken: process.env.RECOURSE_ADMIN_TOKEN ?? "dev-admin-token",
};
