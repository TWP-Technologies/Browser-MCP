/**
 * Modified by [KnotFalse].
 */

import { list_cross_host_candidate_urls, serve_on_available_cross_host_port } from "./cross_host_fixture";

function render_fixture_html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser MCP Manual Fixture</title>
    <style>
      body { font-family: sans-serif; margin: 24px; }
      #dropzone { width: 220px; height: 120px; border: 2px dashed #666; display: grid; place-items: center; margin-top: 16px; }
      #drag-source { width: 120px; padding: 12px; background: #d9edf7; cursor: grab; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h1>Browser MCP Manual Fixture</h1>
    <p id="status">ready</p>
    <form onsubmit="return false;">
      <label>Name <input id="name-input" name="name" value="" /></label>
      <label><input id="agree-box" type="checkbox" /> Agree</label>
      <label>Color
        <select id="color-select">
          <option>red</option>
          <option>blue</option>
        </select>
      </label>
    </form>
    <button id="fetch-btn">Fetch data</button>
    <button id="dialog-btn">Open dialog</button>
    <div id="drag-source" draggable="true">drag me</div>
    <div id="dropzone">drop here</div>
    <script>
      console.log("fixture-loaded");
      fetch("/api/data?source=load")
        .then((response) => response.json())
        .then((data) => {
          console.log("load-data", data.message);
        })
        .catch((error) => {
          console.error("load-data-error", error);
        });
      document.getElementById("fetch-btn").addEventListener("click", async () => {
        try {
          const response = await fetch("/api/data?source=button");
          const data = await response.json();
          document.getElementById("status").textContent = data.message;
        } catch (error) {
          document.getElementById("status").textContent = "fetch-error";
          console.error("fetch-btn-error", error);
        }
      });
      document.getElementById("dialog-btn").addEventListener("click", () => {
        const confirmed = confirm("Do you want to continue?");
        document.getElementById("status").textContent = confirmed ? "dialog-confirmed" : "dialog-cancelled";
      });
      const source = document.getElementById("drag-source");
      const zone = document.getElementById("dropzone");
      source.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", "drag me");
      });
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) => {
        event.preventDefault();
        document.getElementById("status").textContent = event.dataTransfer.getData("text/plain") || "dropped";
      });
    </script>
  </body>
</html>`;
}

function parse_port(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function collect_excluded_ports(): number[] {
  const ports = new Set<number>([37777, 37778]);
  const configured_bridge_port = parse_port(process.env.BRIDGE_PORT);
  const configured_daemon_port = parse_port(process.env.MCP_DAEMON_PORT);

  if (configured_bridge_port !== undefined) {
    ports.add(configured_bridge_port);
    if (configured_daemon_port === undefined && configured_bridge_port < 65535) {
      // The daemon defaults to bridge_port + 1 when MCP_DAEMON_PORT is unset.
      ports.add(configured_bridge_port + 1);
    }
  }

  if (configured_daemon_port !== undefined) {
    ports.add(configured_daemon_port);
  }

  return Array.from(ports);
}

function render_usage(urls: string[], port: number): string {
  const lines = [
    "manual validation fixture ready",
    "",
    "candidate URLs:",
    ...urls.map((url) => `- ${url}`),
    "",
    "notes:",
    "- MCP bridge settings stay loopback-only.",
    "- This fixture is intentionally cross-host for live browser validation from another network namespace, such as Windows Chrome reaching a WSL-hosted Bun process.",
    `- If Windows Chrome cannot open http://127.0.0.1:${port}/, try the non-loopback candidate URLs listed above instead.`,
  ];

  return lines.join("\n");
}

const server = await serve_on_available_cross_host_port({
  excluded_ports: collect_excluded_ports(),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(render_fixture_html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/data") {
      const source = url.searchParams.get("source") ?? "unknown";
      return Response.json({ ok: true, message: `api:${source}` });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(render_usage(list_cross_host_candidate_urls(server.port), server.port));

async function stop_manual_validation_fixture(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  console.log(`received ${signal}; stopping manual validation fixture`);
  try {
    await server.stop(true);
    process.exit(0);
  } catch (error) {
    console.error("failed to stop manual validation fixture", error);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop_manual_validation_fixture(signal);
  });
}
