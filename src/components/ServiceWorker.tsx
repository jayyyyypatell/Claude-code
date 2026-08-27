"use client";

import { useEffect } from "react";

/**
 * Register the service worker.
 *
 * Registered after load rather than during render, so it never competes with
 * the first paint for bandwidth.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = (): void => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failure is not worth surfacing — the app works fine
        // without offline support.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
