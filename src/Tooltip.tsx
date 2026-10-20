import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

const EDGE = 8;
// Only one tooltip is open at a time: opening another closes this one at once.
let current: { id: string; close: () => void } | null = null;

/** An info button whose explanation opens on hover, keyboard focus or tap, and closes on Escape.
 *  The panel always sits fully on screen (below the button, above it, or clamped) and stays open
 *  while the pointer is over it, so long explanations can be read and selected. */
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
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0, width: Math.min(width, innerWidth - 2 * EDGE), visibility: "hidden" });
  const close = () => {
    window.clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
  };
  const cancelClose = () => window.clearTimeout(timer.current);
  // A short delay lets the pointer travel from the button onto the panel without it vanishing.
  const closeSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 160);
  };
  useLayoutEffect(() => {
    if (!open) return;
    if (current && current.id !== id) current.close();
    current = { id, close };
    return () => {
      if (current?.id === id) current = null;
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const panelWidth = Math.min(width, innerWidth - 2 * EDGE);
      let top = anchor.bottom + 10;
      if (top + box.height > innerHeight - EDGE) top = anchor.top - 10 - box.height;
      top = Math.max(EDGE, Math.min(top, innerHeight - box.height - EDGE));
      const left = Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - panelWidth / 2, innerWidth - panelWidth - EDGE));
      // Only a panel taller than the window scrolls, as a last resort.
      setStyle({ position: "fixed", top, left, width: panelWidth, maxHeight: innerHeight - 2 * EDGE, overflowY: box.height > innerHeight - 2 * EDGE ? "auto" : "visible" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width, children]);
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
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`tooltip-trigger ${className}`}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={(event) => event.pointerType === "mouse" && closeSoon()}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={() => !pinned.current && closeSoon()}
        onClick={() => {
          pinned.current = !(pinned.current && open);
          setOpen(pinned.current);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="tooltip"
            data-tooltip
            className="tooltip-panel"
            style={style}
            onPointerEnter={cancelClose}
            onPointerLeave={(event) => event.pointerType === "mouse" && closeSoon()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
