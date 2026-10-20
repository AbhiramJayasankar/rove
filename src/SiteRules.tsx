import { useState } from "react";
import { Trash2 } from "lucide-react";
import { normalizePattern, type SiteAction, type SiteRule } from "../shared/siteRules";

const actions: { value: SiteAction; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
];

export default function SiteRules({ rules, onChange }: { rules: SiteRule[]; onChange: (rules: SiteRule[]) => void }) {
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
        <h2 className="settings-title">Site rules</h2>
      </div>
      <div className="panel rules-panel">
        {rules.map((rule) => (
          <div className="rule-row" key={rule.pattern}>
            <strong>{rule.pattern}</strong>
            <div className="rule-choice" role="radiogroup" aria-label={`Rule for ${rule.pattern}`}>
              {actions.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={rule.action === choice.value}
                  className={`rule-${choice.value}`}
                  onClick={() => onChange(rules.map((item) => (item.pattern === rule.pattern ? { ...item, action: choice.value } : item)))}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <button type="button" className="icon-button" aria-label={`Remove rule for ${rule.pattern}`} onClick={() => onChange(rules.filter((item) => item.pattern !== rule.pattern))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!rules.length && <p className="rules-empty">Rules override Auto-approve and Ask first for one site and its subdomains. Blocked sites are never opened.</p>}
        <div className="rule-add">
          <input
            aria-label="Site to add"
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
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
