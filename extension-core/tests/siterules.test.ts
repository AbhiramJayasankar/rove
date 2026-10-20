import { describe, expect, it } from "vitest";
import { hostOf, normalizePattern, ruleFor } from "../../shared/siteRules";

describe("site rules", () => {
  it("normalizes what people type", () => {
    expect(normalizePattern("https://www.Example.com/path?q=1")).toBe("www.example.com");
    expect(normalizePattern("*.example.com")).toBe("example.com");
    expect(normalizePattern("localhost:3000")).toBe("localhost");
    expect(normalizePattern("not a host")).toBeNull();
    expect(normalizePattern("")).toBeNull();
  });
  it("matches a host and its subdomains, never lookalikes", () => {
    const rules = [{ pattern: "example.com", action: "block" as const }];
    expect(ruleFor(rules, "example.com")?.action).toBe("block");
    expect(ruleFor(rules, "a.b.example.com")?.action).toBe("block");
    expect(ruleFor(rules, "notexample.com")).toBeUndefined();
    expect(ruleFor(rules, "example.com.evil.io")).toBeUndefined();
    expect(ruleFor(rules, undefined)).toBeUndefined();
  });
  it("prefers the most specific rule, then the stricter action", () => {
    const rules = [
      { pattern: "example.com", action: "block" as const },
      { pattern: "docs.example.com", action: "allow" as const },
    ];
    expect(ruleFor(rules, "docs.example.com")?.action).toBe("allow");
    expect(ruleFor(rules, "shop.example.com")?.action).toBe("block");
    expect(ruleFor([{ pattern: "a.com", action: "allow" as const }, { pattern: "a.com", action: "ask" as const }], "a.com")?.action).toBe("ask");
  });
  it("only reads http and https hosts", () => {
    expect(hostOf("https://Sub.Example.com/x")).toBe("sub.example.com");
    expect(hostOf("file:///c:/x")).toBeUndefined();
    expect(hostOf("nonsense")).toBeUndefined();
  });
});
