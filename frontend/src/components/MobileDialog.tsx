import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Props = {
  children: ReactNode;
  className?: string;
  description: string;
  onClose: () => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  title: string;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function MobileDialog({
  children,
  className = "",
  description,
  onClose,
  open,
  returnFocusRef,
  title,
}: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const returnTarget = returnFocusRef?.current ?? document.activeElement;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      surfaceRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (returnTarget instanceof HTMLElement) returnTarget.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  return createPortal(
    <div
      className="mobile-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`mobile-dialog ${className}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [
            ...(surfaceRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
          ];
          const first = focusable.at(0);
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={surfaceRef}
        role="dialog"
      >
        <header className="mobile-dialog-header">
          <div>
            <p className="eyebrow">Mobile workspace</p>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button aria-label={`Close ${title}`} data-autofocus onClick={onClose}>
            Close
          </button>
        </header>
        <div className="mobile-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
