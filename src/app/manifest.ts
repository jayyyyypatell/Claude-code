import type { MetadataRoute } from "next";

/**
 * The web app manifest.
 *
 * What turns "a website you bookmarked" into something that opens fullscreen
 * from the home screen with its own icon and no browser chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Life Tracker",
    short_name: "Life",
    description: "Your health, habits and journal in one place.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f9f9f7",
    theme_color: "#f9f9f7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        // Maskable: Android crops icons to its own shape, and a non-maskable
        // icon gets its corners cut off.
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
