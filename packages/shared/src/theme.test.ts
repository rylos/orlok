import { describe, expect, it } from "vitest";
import { isThemePreference, resolveTheme, themeMode } from "./theme";

describe("resolveTheme", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("mocha");
    expect(resolveTheme("system", false)).toBe("latte");
  });

  it("honors an explicit choice regardless of the system", () => {
    expect(resolveTheme("tokyo-night", false)).toBe("tokyo-night");
    expect(resolveTheme("latte", true)).toBe("latte");
  });
});

describe("isThemePreference", () => {
  it("accepts known values only", () => {
    expect(isThemePreference("mocha")).toBe(true);
    expect(isThemePreference("dracula")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

describe("themeMode", () => {
  it("tells light and dark apart", () => {
    expect(themeMode("latte")).toBe("light");
    expect(themeMode("tokyo-night")).toBe("dark");
  });
});
