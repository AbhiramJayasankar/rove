import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/** An info button whose explanation opens on hover, keyboard focus or tap, and closes on Escape. */
export default function Tooltip({
  label,
  children,
  width = 300,
  className = "",
}: {
  label: string;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const popupWidth = Math.min(width, innerWidth - 24);
    const below = rect.bottom + 10;
    const spaceBelow = innerHeight - rect.bottom - 16;
    const above = spaceBelow < 180 && rect.top > spaceBelow;
    setStyle({
      position: "fixed",
      width: popupWidth,
      left: Math.max(12, Math.min(rect.left + rect.width / 2 - popupWidth / 2, innerWidth - popupWidth - 12)),
      ...(above ? { bottom: innerHeight - rect.top + 10, maxHeight: Math.max(120, rect.top - 24) } : { top: below, maxHeight: Math.max(120, spaceBelow) }),
    });
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        trigger.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[data-tooltip]")) close();
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`tooltip-trigger ${className}`}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerEnter={(event) => event.pointerType === "mouse" && setOpen(true)}
        onPointerLeave={(event) => event.pointerType === "mouse" && !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
        onClick={() => {
          setPinned(!pinned || !open);
          setOpen(!pinned || !open);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div id={id} role="tooltip" data-tooltip className="tooltip-panel" style={style}>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
