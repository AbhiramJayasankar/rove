import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/** Shared non-modal popup geometry and dismissal for all compact controls. */
export function usePopover({
  width = 240,
  placement = "top",
}: { width?: number; placement?: "top" | "bottom" } = {}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const popupWidth = Math.min(width, innerWidth - 24);
      const above = rect.top - 12,
        below = innerHeight - rect.bottom - 12;
      const top =
        placement === "top"
          ? above >= 180 || above > below
          : below < 180 && above > below;
      setStyle({
        position: "fixed",
        width: popupWidth,
        left: Math.max(12, Math.min(rect.left, innerWidth - popupWidth - 12)),
        ...(top
          ? {
              bottom: innerHeight - rect.top + 7,
              maxHeight: Math.max(80, Math.min(370, above - 7)),
            }
          : {
              top: rect.bottom + 7,
              maxHeight: Math.max(80, Math.min(370, below - 7)),
            }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width, placement]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    const focus = (event: FocusEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("focusin", focus);
    };
  }, [open]);
  return { trigger, panel, open, setOpen, close, style };
}
