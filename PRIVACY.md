# Privacy Policy

Last updated: 2026-03-04

This policy applies to the Chrome Browser MCP project in this repository, including:

- The local MCP server binary/runtime
- The local Chrome extension bridge

## What We Collect

We do not operate a remote backend for this project and we do not collect or store your browsing data on our own servers.

For Chrome Web Store disclosure, the extension can access:

- **User activity** (for example: network activity, clicks, scroll state, typed interaction routed through tool calls)
- **Website content** (for example: text, images, links, DOM/page content, screenshots, exported PDFs)

## How Data Is Used

Data is processed locally to execute MCP tool requests from your connected agent/client.

This project does not transmit that data to a project-owned cloud service.

## Important Third-Party Caveat

Your connected LLM agent/tooling stack may store prompts, tool inputs/outputs, and logs externally (for example, agent logs, telemetry, or hosted model history).  
Those systems are outside this project's control.

## Security Notes

- Default network binding is loopback-only (`127.0.0.1`).
- Optional token auth can be enabled.
- Internet content can contain prompt-injection attacks; use caution with sensitive workflows.

## Data Retention

No project-operated remote retention exists for extension/server traffic.

## Contact

For project questions, open an issue in this repository.
