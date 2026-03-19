/**
 * Modified by [KnotFalse].
 */

import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

export interface cross_host_fixture_options {
  fetch: (request: Request) => Response | Promise<Response>;
  excluded_ports?: Iterable<number>;
  attempts?: number;
  hostname?: string;
}

function is_address_in_use(error: unknown): boolean {
  return !!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE");
}

async function reserve_port_on_host(hostname: string, excluded_ports: Set<number>): Promise<number> {
  // This only reserves a candidate port for the subsequent Bun.serve() call.
  // Another process can still claim the port after close(), so callers must retry on EADDRINUSE.
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (Number.isInteger(port) && port > 0 && !excluded_ports.has(port)) {
          resolve(port);
          return;
        }

        reject(new Error(`failed to reserve a usable port on ${hostname}: ${String(port)}`));
      });
    });
  });
}

export async function serve_on_available_cross_host_port(options: cross_host_fixture_options): Promise<Bun.Server> {
  const hostname = typeof options.hostname === "string" && options.hostname.trim().length > 0
    ? options.hostname.trim()
    : "0.0.0.0";
  const excluded_ports = new Set(Array.from(options.excluded_ports ?? []));
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 20;
  let last_error: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let port = 0;

    try {
      port = await reserve_port_on_host(hostname, excluded_ports);
      excluded_ports.add(port);
    } catch (error) {
      last_error = error;
      continue;
    }

    try {
      return Bun.serve({
        port,
        hostname,
        fetch: options.fetch,
      });
    } catch (error) {
      last_error = error;
      if (is_address_in_use(error)) {
        continue;
      }

      throw error;
    }
  }

  throw (last_error instanceof Error
    ? last_error
    : new Error(`failed to start Bun server on ${hostname}`, { cause: last_error }));
}

function is_non_internal_ipv4(value: NetworkInterfaceInfo): value is NetworkInterfaceInfo & { family: "IPv4"; internal: false } {
  return value.family === "IPv4" && value.internal === false && !value.address.startsWith("169.254.");
}

export function list_cross_host_candidate_urls(port: number): string[] {
  const urls = new Set<string>();

  urls.add(`http://127.0.0.1:${port}/`);

  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (is_non_internal_ipv4(entry)) {
        urls.add(`http://${entry.address}:${port}/`);
      }
    }
  }

  return Array.from(urls);
}
