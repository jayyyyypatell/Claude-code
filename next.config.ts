import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The timezone has to reach the browser as well as the server.
   *
   * Client components render hover tooltips with wall-clock times, and
   * `process.env.USER_TIMEZONE` is undefined in the browser bundle — so
   * without this mapping those times silently fall back to UTC and a 23:30
   * bedtime renders as 03:30. Exposing it here keeps one variable in
   * `.env.local` while making it available on both sides.
   *
   * A timezone name is not a secret; nothing sensitive is being published.
   */
  env: {
    NEXT_PUBLIC_USER_TIMEZONE: process.env.USER_TIMEZONE ?? "UTC",
  },
};

export default nextConfig;
