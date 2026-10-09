import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A narrow gateway to the facilitator. Public reads (the transparency log) pass
// through as they are; the few admin calls the pages need get the admin token added
// here, on the server. Everything else is refused, so this is not an open admin proxy.
const PUBLIC_GET = [/^health$/, /^v1\/log\/head$/, /^v1\/log$/, /^v1\/log\/\d+$/, /^v1\/anchors$/, /^\.well-known\/recourse\.json$/];
const ADMIN_GET = [/^v1\/admin\/owners$/, /^v1\/admin\/owners\/[\w-]+$/, /^v1\/admin\/publishers$/, /^v1\/admin\/publishers\/[\w-]+$/, /^v1\/admin\/claims$/];
const ADMIN_POST = [/^v1\/admin\/owners\/[\w-]+\/(vault|mandate|topups)$/];

const matches = (list: RegExp[], p: string) => list.some((r) => r.test(p));

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const p = path.join("/");
  const method = req.method;
  const isAdmin = (method === "GET" && matches(ADMIN_GET, p)) || (method === "POST" && matches(ADMIN_POST, p));
  const isPublic = method === "GET" && matches(PUBLIC_GET, p);
  if (!isAdmin && !isPublic) {
    return Response.json({ error: "not_allowed", message: `${method} /${p} is not available through the web app.` }, { status: 404 });
  }

  const url = new URL(req.url);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isAdmin) headers.Authorization = `Bearer ${env.adminToken}`;
  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    body = await req.text();
  }

  try {
    const res = await fetch(`${env.facilitatorUrl}/${p}${url.search}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return Response.json(
      { error: "facilitator_unreachable", message: `Could not reach the facilitator at ${env.facilitatorUrl}. ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
