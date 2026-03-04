import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const current_dir = dirname(fileURLToPath(import.meta.url));
const popup_css_path = resolve(current_dir, "../../chrome-extension/popup.css");
const popup_css = readFileSync(popup_css_path, "utf8");

test("popup css defines calm motion tokens", () => {
  expect(popup_css).toContain("--motion-duration-fast: 200ms;");
  expect(popup_css).toContain("--motion-duration-standard: 260ms;");
  expect(popup_css).toContain("--motion-duration-slow: 320ms;");
  expect(popup_css).toContain("--motion-duration-pulse: 900ms;");
  expect(popup_css).toContain("--motion-ease-standard: ease-out;");
});

test("popup css uses 768px default width with viewport fallback", () => {
  expect(popup_css).toContain("width: min(768px, 100vw);");
  expect(popup_css).toContain("max-width: 768px;");
});

test("poll pulse animation uses calm duration token", () => {
  expect(popup_css).toMatch(
    /\.poll-indicator--pulse\s*\{[\s\S]*animation:\s*poll-pulse\s+var\(--motion-duration-pulse\)\s+var\(--motion-ease-standard\);/m,
  );
});

test("popup css no longer contains legacy hyperfast duration literals", () => {
  expect(popup_css).not.toContain("120ms");
  expect(popup_css).not.toContain("140ms");
  expect(popup_css).not.toContain("420ms");
});

test("reduced motion media query still disables transitions and animations", () => {
  expect(popup_css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(popup_css).toMatch(
    /\.btn,[\s\S]*input\[type="number"\],[\s\S]*\.url-copy-surface\s*\{[\s\S]*transition:\s*none;/m,
  );
  expect(popup_css).toMatch(/\.poll-indicator--pulse\s*\{[\s\S]*animation:\s*none;/m);
});
