/**
 * Working out how this machine is reachable from a phone on the same WiFi.
 *
 * Used by `setup.mjs` to print the URL, and by `lan.mjs` to print it again
 * when the server starts — because on DHCP it can change between the two.
 */
import os from "node:os";

/** Interfaces that are never the one you want. */
const JUNK = /^(awdl|llw|utun|bridge|vmnet|docker|veth|lo|ap\d|anpi|vboxnet)/i;

/**
 * LAN IPv4 addresses, best first.
 *
 * A Mac with an Ethernet dock genuinely has two, so this returns the list
 * rather than a winner — printing both beats printing the wrong one.
 */
export function detectLanAddresses() {
  const found = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (JUNK.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Link-local means DHCP failed; it will not be reachable.
      if (a.address.startsWith("169.254.")) continue;
      found.push({ name, address: a.address });
    }
  }

  const rank = (e) => {
    let score = 0;
    // en0 is WiFi on a Mac, which is the interface the phone is also on.
    if (e.name === "en0") score -= 100;
    else if (/^en/.test(e.name)) score -= 50;
    if (e.address.startsWith("192.168.")) score -= 10;
    else if (e.address.startsWith("10.")) score -= 5;
    return score;
  };

  return found.sort((a, b) => rank(a) - rank(b)).map((e) => e.address);
}

/**
 * The machine's Bonjour name, on platforms that publish one.
 *
 * Preferred over the IP address because it survives a DHCP renewal, a router
 * reboot, and moving between a router's 2.4GHz and 5GHz bands — all of which
 * silently break a hard-coded IP in the phone's automation. iOS resolves
 * `.local` natively with nothing to install.
 *
 * Returns null off macOS: a Linux box without Avahi will not answer to it, and
 * printing an address that doesn't work is worse than printing none.
 */
export function localHostname() {
  if (process.platform !== "darwin") return null;
  const raw = os.hostname().toLowerCase().replace(/\.$/, "");
  if (!raw || raw === "localhost") return null;
  return raw.endsWith(".local") ? raw : `${raw}.local`;
}

/** Every address worth trying, `.local` first. */
export function reachableHosts() {
  const hosts = [];
  const bonjour = localHostname();
  if (bonjour) hosts.push(bonjour);
  hosts.push(...detectLanAddresses());
  return hosts;
}
