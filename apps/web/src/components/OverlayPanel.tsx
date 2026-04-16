import { ReactNode, useEffect } from "react";

interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  mode?: "center" | "left" | "right";
  children: ReactNode;
}

export default function OverlayPanel({
  open,
  onClose,
  title,
  mode = "center",
  children
}: OverlayPanelProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="overlayBackdrop" onMouseDown={onClose} role="presentation">
      <section
        className={`overlayPanel overlayPanel--${mode}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="overlayPanel__head">
          <h2>{title}</h2>
          <button className="uiButton uiButton--ghost" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="overlayPanel__body">{children}</div>
      </section>
    </div>
  );
}
