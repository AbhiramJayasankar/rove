import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { usePopover } from "./Popover";
export type Choice = { value: string; label: string; description?: string };
export default function ChoiceMenu({
  value,
  options,
  onChange,
  label,
  icon,
  className = "",
  placement = "bottom",
  disabled = false,
  displayLabel,
}: {
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  label: string;
  icon?: ReactNode;
  className?: string;
  placement?: "top" | "bottom";
  disabled?: boolean;
  displayLabel?: string;
}) {
  const id = useId();
  const popup = usePopover({ placement, width: 240 });
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.value === value);
  function show() {
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    popup.setOpen(true);
  }
  function choose(next: string) {
    onChange(next);
    popup.close(true);
  }
  useEffect(() => {
    if (popup.open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, popup.open, id]);
  return (
    <>
      <button
        ref={popup.trigger}
        type="button"
        role="combobox"
        className={`choice-trigger ${className}`}
        aria-label={label}
        title={selected?.label}
        disabled={disabled}
        aria-expanded={popup.open}
        aria-controls={popup.open ? id : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={popup.open ? `${id}-${active}` : undefined}
        onClick={() => (popup.open ? popup.close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!popup.open) show();
            else
              setActive(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                  options.length,
              );
          } else if (event.key === "Home" && popup.open) {
            event.preventDefault();
            setActive(0);
          } else if (event.key === "End" && popup.open) {
            event.preventDefault();
            setActive(options.length - 1);
          } else if (
            (event.key === "Enter" || event.key === " ") &&
            popup.open
          ) {
            event.preventDefault();
            if (options[active]) choose(options[active].value);
          }
        }}
      >
        {icon}
        <span>{displayLabel || selected?.label || "Choose"}</span>
        <ChevronDown size={11} />
      </button>
      {popup.open &&
        createPortal(
          <div
            ref={popup.panel}
            id={id}
            role="listbox"
            aria-label={label}
            className="choice-menu anchored-popover"
            style={popup.style}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-label={option.label}
                aria-describedby={
                  option.description ? `${id}-${index}-description` : undefined
                }
                aria-selected={option.value === value}
                className={`choice-option ${index === active ? "active" : ""}`}
                onPointerMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.description && (
                    <small id={`${id}-${index}-description`}>
                      {option.description}
                    </small>
                  )}
                </span>
                {option.value === value && <Check size={13} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
