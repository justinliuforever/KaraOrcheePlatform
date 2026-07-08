import { useEffect } from "react";
import type { ReactNode } from "react";

/** Right slide-over drawer. Esc closes; the overlay click closes; onBeforeClose
 * can veto (unsaved-changes guard). */
export default function SlideOver({
  width = "min(68vw, 980px)",
  onClose,
  onBeforeClose,
  header,
  children,
}: {
  width?: string;
  onClose: () => void;
  onBeforeClose?: () => boolean; // return false to veto
  header: ReactNode;
  children: ReactNode;
}) {
  const tryClose = () => {
    if (onBeforeClose && !onBeforeClose()) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <>
      <div className="fixed inset-0 bg-black/25 z-40" onClick={tryClose} />
      <aside
        className="fixed inset-y-0 right-0 bg-paper border-l border-line z-50 overflow-y-auto shadow-2xl"
        style={{ width }}
      >
        <div className="sticky top-0 z-10 bg-card border-b border-line px-6 py-3.5">{header}</div>
        <div className="px-6 py-5">{children}</div>
      </aside>
    </>
  );
}
