import { redirect } from "next/navigation";

import { NavBar } from "@/components/NavBar";
import { ServiceWorker } from "@/components/ServiceWorker";
import { authEnabled, getSession } from "@/lib/auth";

/**
 * The authenticated shell.
 *
 * Every page in this route group inherits this gate, so protection is
 * structural rather than something each new page has to remember to add.
 * That matters more than it sounds: the usual way an app like this leaks is
 * someone adding a page and forgetting the check.
 *
 * This is the *enforcement* point. `proxy.ts` also redirects unauthenticated
 * requests, but only for speed — proxy-only authentication has a poor track
 * record, and a check that runs where the data is actually read is the one
 * that can't be routed around.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (authEnabled()) {
    const session = await getSession();
    if (!session.authenticated) redirect("/login");
  }

  return (
    <>
      <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 sm:px-6">
        {children}
      </div>
      <NavBar />
      <ServiceWorker />
    </>
  );
}
