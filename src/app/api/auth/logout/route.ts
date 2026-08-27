import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  session.destroy();
  return Response.redirect(new URL("/login", req.url), 303);
}
