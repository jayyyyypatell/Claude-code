import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Life",
  description: "Your health, habits and journal in one place.",
  applicationName: "Life",
  // What makes it feel like an app rather than a browser tab once it's on the
  // home screen.
  appleWebApp: {
    capable: true,
    title: "Life",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Required for the safe-area insets to resolve — without it the tab bar
  // sits underneath the home indicator on any modern iPhone.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* The shell (nav, page padding) lives in the (app) layout, so /login
          renders without a tab bar it can't use. */}
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
