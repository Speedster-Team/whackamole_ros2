import os from "node:os";
import type { NextConfig } from "next";

function localOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1"]);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === "IPv4") {
        origins.add(iface.address);
      }
    }
  }
  try {
    origins.add(os.hostname());
    origins.add(`${os.hostname()}.local`);
  } catch {
    /* ignore */
  }
  return Array.from(origins);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: localOrigins(),
};

export default nextConfig;
