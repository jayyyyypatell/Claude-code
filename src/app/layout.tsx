import type { Metadata, Viewport } from "next";

import { NavBar } from "@/components/NavBar";

import "./globals.css";

export const metadata: Metadata = {
  title: "Life",
  description: "Your health, habits and journal in one place.",
  // Installed to the iPhone home screen, this is what makes it feel like an
  // app rather than a browser tab. Expanded in M6 alongside the manifest.
  appleWebApp: {
    capable: true,
    title: "Life",
    statusBarStyle: "black-translucent",
  },
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
      <body className="min-h-dvh">
        <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 sm:px-6">
          {children}
        </div>
        <NavBar />
      </body>
    </html>
  );
}
