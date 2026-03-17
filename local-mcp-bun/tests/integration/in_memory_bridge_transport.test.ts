import { expect, test } from "bun:test";
import { in_memory_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";

interface missing_tab_case {
  tool_name: string;
  args: Record<string, unknown>;
}

const missing_tab_cases: missing_tab_case[] = [
  {
    tool_name: "browser_snapshot",
    args: {},
  },
  {
    tool_name: "browser_lookup",
    args: {
      text: "Continue",
    },
  },
  {
    tool_name: "browser_interact",
    args: {
      action: "click",
      selector: "button.primary-action",
    },
  },
  {
    tool_name: "browser_fill_form",
    args: {
      fields: [{ selector: "input[name='email']" }],
    },
  },
  {
    tool_name: "browser_get_element_styles",
    args: {
      selector: "button.primary-action",
    },
  },
  {
    tool_name: "browser_take_screenshot",
    args: {},
  },
];

function create_bridge(): in_memory_bridge_transport {
  const bridge = new in_memory_bridge_transport();
  bridge.set_tabs_for_tests([
    {
      tab_id: 101,
      url: "https://example.com",
      title: "Example",
      debugger_attached: false,
      active: true,
    },
  ]);
  return bridge;
}

for (const test_case of missing_tab_cases) {
  test(`in-memory ${test_case.tool_name} returns TAB_NOT_FOUND for an unknown tab`, async () => {
    const bridge = create_bridge();

    try {
      await bridge.call_tool(test_case.tool_name, test_case.args, "agent-a", 999);
      throw new Error("expected call_tool to reject for an unknown tab");
    } catch (error) {
      expect(error).toBeInstanceOf(tool_error);
      expect((error as tool_error).code).toBe("TAB_NOT_FOUND");
    }
  });
}

test("in-memory browser_tabs new preserves the active tab when activate=false", async () => {
  const bridge = create_bridge();
  await bridge.call_tool(
    "browser_tabs",
    {
      action: "new",
      url: "https://example.org/background",
      activate: false,
    },
    "agent-a",
  );

  const listed_tabs = (await bridge.call_tool("browser_tabs", { action: "list" }, "agent-a")) as {
    tabs: Array<{ tab_id: number; active?: boolean }>;
  };

  expect(listed_tabs.tabs.find((tab) => tab.tab_id === 101)?.active).toBe(true);
  expect(listed_tabs.tabs.find((tab) => tab.tab_id !== 101)?.active).toBe(false);
});

test("in-memory browser_navigate rejects unsupported history actions instead of returning synthetic success", async () => {
  const bridge = create_bridge();

  try {
    await bridge.call_tool("browser_navigate", { action: "back" }, "agent-a", 101);
    throw new Error("expected browser_navigate back to reject in the in-memory bridge");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
  }
});

test("in-memory browser_navigate reload remains a valid no-op", async () => {
  const bridge = create_bridge();
  const response = (await bridge.call_tool("browser_navigate", { action: "reload" }, "agent-a", 101)) as {
    action: string;
    url: string;
  };

  expect(response.action).toBe("reload");
  expect(response.url).toBe("https://example.com");
});
