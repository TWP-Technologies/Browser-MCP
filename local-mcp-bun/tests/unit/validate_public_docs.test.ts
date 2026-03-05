import { describe, expect, test } from "bun:test";
import { validate_public_docs } from "../../scripts/validate_public_docs";

const valid_readme = `
# Chrome Browser MCP

Download chrome-browser-mcp-chrome-extension-v<version>.zip and extract it.
Open chrome://extensions and click Load unpacked.
Run chmod +x ./chrome-browser-mcp-v<version>-linux-x64 on Linux/macOS.

codex mcp add chrome-browser-mcp -- /path/to/server
claude mcp add chrome-browser-mcp -- /path/to/server
gemini mcp add chrome-browser-mcp /path/to/server

Default is BRIDGE_PORT=37777.
This project does not send or store browsing data remotely.
See PRIVACY.md for details.
Internet content can include prompt-injection attacks.
`;

const valid_privacy = `
# Privacy Policy

We do not collect or store browser data remotely.
Categories:
- User activity
- Website content

Agent/provider handling is outside this project's control.
`;

describe("validate_public_docs", () => {
  test("passes for complete README and privacy policy text", () => {
    const errors = validate_public_docs({
      readme_text: valid_readme,
      privacy_text: valid_privacy,
    });
    expect(errors).toEqual([]);
  });

  test("fails when README misses MCP client setup commands", () => {
    const errors = validate_public_docs({
      readme_text: valid_readme.replace("gemini mcp add chrome-browser-mcp /path/to/server", ""),
      privacy_text: valid_privacy,
    });

    expect(errors.some((entry) => entry.includes("Gemini CLI MCP setup command"))).toBe(true);
  });

  test("fails when privacy policy misses required category disclosure", () => {
    const errors = validate_public_docs({
      readme_text: valid_readme,
      privacy_text: valid_privacy.replace("Website content", "Page data"),
    });

    expect(errors.some((entry) => entry.includes("Website content category"))).toBe(true);
  });
});
