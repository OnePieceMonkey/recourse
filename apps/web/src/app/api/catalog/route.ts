import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const res = await fetch(env.catalogUrl, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return Response.json({ error: "catalog_error", message: `Catalog answered HTTP ${res.status}.` }, { status: 502 });
    return Response.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: "catalog_unreachable", message: (e as Error).message }, { status: 502 });
  }
}
