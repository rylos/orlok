import { describe, expect, it } from "vitest";
import { isLocale, matchLocale } from "./i18n";

describe("matchLocale", () => {
  it("picks the first supported language ignoring the region", () => {
    expect(matchLocale(["it-IT", "en-US"])).toBe("it");
    expect(matchLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(matchLocale(["EN_us"])).toBe("en");
  });

  it("returns null when no language is supported", () => {
    expect(matchLocale(["fr", "de"])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });
});

describe("isLocale", () => {
  it("accepts supported languages only", () => {
    expect(isLocale("it")).toBe(true);
    expect(isLocale("it-IT")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
