import { useState } from "react";
import { Trash2 } from "lucide-react";
import { normalizePattern, type SiteAction, type SiteRule } from "../shared/siteRules";
import { useT } from "./i18n";

const actions: { value: SiteAction; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
];

export default function SiteRules({ rules, onChange }: { rules: SiteRule[]; onChange: (rules: SiteRule[]) => void }) {
  const t = useT();
  const [input, setInput] = useState("");
  const pattern = normalizePattern(input);
  function add(action: SiteAction) {
    if (!pattern) return;
    onChange([...rules.filter((rule) => rule.pattern !== pattern), { pattern, action }]);
    setInput("");
  }
  return (
    <>
      <div className="settings-heading">
        <h2 className="settings-title">{t("Site rules")}</h2>
      </div>
      <div className="panel rules-panel">
        {rules.map((rule) => (
          <div className="rule-row" key={rule.pattern}>
            <strong>{rule.pattern}</strong>
            <div className="rule-choice" role="radiogroup" aria-label={t("Rule for {site}", { site: rule.pattern })}>
              {actions.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={rule.action === choice.value}
                  className={`rule-${choice.value}`}
                  onClick={() => onChange(rules.map((item) => (item.pattern === rule.pattern ? { ...item, action: choice.value } : item)))}
                >
                  {t(choice.label)}
                </button>
              ))}
            </div>
            <button type="button" className="icon-button" aria-label={t("Remove rule for {site}", { site: rule.pattern })} onClick={() => onChange(rules.filter((item) => item.pattern !== rule.pattern))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!rules.length && <p className="rules-empty">{t("Rules override Auto-approve and Ask first for one site and its subdomains. Blocked sites are never opened.")}</p>}
        <div className="rule-add">
          <input
            aria-label={t("Site to add")}
            placeholder="example.com"
            value={input}
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add("ask");
              }
            }}
          />
          {actions.map((choice) => (
            <button key={choice.value} type="button" className={`rule-add-${choice.value}`} disabled={!pattern} aria-label={`${choice.label} ${pattern ?? "site"}`} onClick={() => add(choice.value)}>
              {t(choice.label)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
