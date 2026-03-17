import { createServer } from "node:net";

interface loopback_server_options {
  fetch: (request: Request) => Response | Promise<Response>;
  excluded_ports?: Iterable<number>;
  attempts?: number;
}

async function reserve_loopback_port(excluded_ports: Set<number>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

        reject(new Error(`failed to reserve a usable loopback port: ${String(port)}`));
      });
    });
  });
}

function stringify_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function is_address_in_use(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    return true;
  }

  return stringify_error(error).includes("EADDRINUSE");
}

export async function serve_on_available_loopback_port(options: loopback_server_options): Promise<Bun.Server> {
  const excluded_ports = new Set(Array.from(options.excluded_ports ?? []));
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 20;
  let last_error: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let port = 0;

    try {
      port = await reserve_loopback_port(excluded_ports);
      excluded_ports.add(port);
    } catch (error) {
      last_error = error;
      continue;
    }

    try {
      return Bun.serve({
        port,
        hostname: "127.0.0.1",
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
    : new Error("failed to start Bun loopback server on an available port"));
}
