export type SiteAction = "allow" | "ask" | "block";
export type SiteRule = { pattern: string; action: SiteAction };

const strictness: Record<SiteAction, number> = { allow: 0, ask: 1, block: 2 };

/** Reduce what a user typed ("https://www.Example.com/path", "*.example.com") to a bare host, or null if unusable. */
export function normalizePattern(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^\*\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** A rule for `example.com` covers that host and its subdomains. The most specific rule wins; ties take the stricter action. */
export function ruleFor(rules: SiteRule[], host: string | undefined): SiteRule | undefined {
  if (!host) return undefined;
  let best: SiteRule | undefined;
  for (const rule of rules) {
    if (host !== rule.pattern && !host.endsWith(`.${rule.pattern}`)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && strictness[rule.action] > strictness[best.action])
    )
      best = rule;
  }
  return best;
}
