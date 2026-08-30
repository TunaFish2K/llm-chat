import type { AppSettings } from "@llm-chat/contracts";
import { XProvider } from "@ant-design/x";
import zhCNX from "@ant-design/x/locale/zh_CN";
import { App as AntApp, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, type ComponentProps, type ReactNode } from "react";

export type ColorScheme = "light" | "dark";

export const darkPalette = {
  base: "#202321",
  header: "#252926",
  container: "#292d2a",
  elevated: "#303531",
  code: "#1b1e1c",
  border: "#3d423e",
  borderSecondary: "#343936",
  text: "#eceeec",
  primary: "#57a98c"
} as const;

export function resolveColorScheme(theme: AppSettings["theme"], systemDark: boolean): ColorScheme {
  return theme === "dark" || (theme === "system" && systemDark) ? "dark" : "light";
}

type XTheme = NonNullable<ComponentProps<typeof XProvider>["theme"]>;
type CodeHighlighterConfig = NonNullable<ComponentProps<typeof XProvider>["codeHighlighter"]>;

export function createAppTheme(colorScheme: ColorScheme): XTheme {
  const dark = colorScheme === "dark";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? darkPalette.primary : "#147a5b",
      borderRadius: 6,
      ...(dark
        ? {
            colorBgBase: darkPalette.base,
            colorBgLayout: darkPalette.base,
            colorTextBase: darkPalette.text,
            colorBgContainer: darkPalette.container,
            colorBgElevated: darkPalette.elevated,
            colorBgSpotlight: darkPalette.elevated,
            colorBorder: darkPalette.border,
            colorBorderSecondary: darkPalette.borderSecondary
          }
        : { colorBgBase: "#f5f6f4", colorBgContainer: "#ffffff", colorBgElevated: "#ffffff" })
    },
    components: {
      Layout: {
        bodyBg: dark ? darkPalette.base : "#f5f6f4",
        headerBg: dark ? darkPalette.header : "#ffffff",
        siderBg: dark ? darkPalette.container : "#fafbf9",
        lightSiderBg: dark ? darkPalette.container : "#fafbf9",
        headerHeight: 56,
        headerPadding: "0"
      },
      ...(dark
        ? {
            CodeHighlighter: {
              colorBgTitle: darkPalette.header,
              colorBorderCode: darkPalette.borderSecondary,
              colorTextTitle: darkPalette.text
            }
          }
        : {})
    }
  };
}

export const darkCodeHighlighterConfig: CodeHighlighterConfig = {
  styles: {
    header: { background: darkPalette.header },
    code: { background: darkPalette.code, borderColor: darkPalette.borderSecondary }
  }
};

export function AppTheme({ colorScheme, children }: { colorScheme: ColorScheme; children: ReactNode }) {
  const dark = colorScheme === "dark";

  useEffect(() => {
    const previous = document.documentElement.style.colorScheme;
    document.documentElement.style.colorScheme = colorScheme;
    return () => { document.documentElement.style.colorScheme = previous; };
  }, [colorScheme]);

  return <XProvider
    locale={{ ...zhCNX, ...zhCN }}
    theme={createAppTheme(colorScheme)}
    {...(dark ? { codeHighlighter: darkCodeHighlighterConfig } : {})}
  >
    <div className="app-theme-root" data-color-scheme={colorScheme}>
      <AntApp className="app-provider">{children}</AntApp>
    </div>
  </XProvider>;
}
