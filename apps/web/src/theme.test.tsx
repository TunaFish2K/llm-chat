import { theme as antdTheme } from "antd";
import { describe, expect, it } from "vitest";
import { createAppTheme, darkCodeHighlighterConfig, darkPalette, resolveColorScheme } from "./theme";

describe("theme", () => {
  it.each([
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["light", false, "light"],
    ["light", true, "light"],
    ["system", false, "light"],
    ["system", true, "dark"]
  ] as const)("resolves %s with systemDark=%s to %s", (setting, systemDark, expected) => {
    expect(resolveColorScheme(setting, systemDark)).toBe(expected);
  });

  it("builds the charcoal dark theme and code component tokens", () => {
    const config = createAppTheme("dark");

    expect(config.algorithm).toBe(antdTheme.darkAlgorithm);
    expect(config.token).toMatchObject({
      colorPrimary: darkPalette.primary,
      colorBgBase: darkPalette.base,
      colorBgLayout: darkPalette.base,
      colorBgContainer: darkPalette.container,
      colorBgElevated: darkPalette.elevated,
      colorTextBase: darkPalette.text
    });
    expect(config.components).toMatchObject({
      Layout: { bodyBg: darkPalette.base, headerBg: darkPalette.header, siderBg: darkPalette.container },
      CodeHighlighter: {
        colorBgTitle: darkPalette.header,
        colorBorderCode: darkPalette.borderSecondary,
        colorTextTitle: darkPalette.text
      }
    });
    expect(darkCodeHighlighterConfig.styles).toMatchObject({
      header: { background: darkPalette.header },
      code: { background: darkPalette.code, borderColor: darkPalette.borderSecondary }
    });
  });

  it("keeps the existing light palette and default algorithm isolated from dark overrides", () => {
    const config = createAppTheme("light");

    expect(config.algorithm).toBe(antdTheme.defaultAlgorithm);
    expect(config.token).toMatchObject({
      colorPrimary: "#147a5b",
      colorBgBase: "#f5f6f4",
      colorBgContainer: "#ffffff",
      colorBgElevated: "#ffffff"
    });
    expect(config.components).not.toHaveProperty("CodeHighlighter");
  });
});
