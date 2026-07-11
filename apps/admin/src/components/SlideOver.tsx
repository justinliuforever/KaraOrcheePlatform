import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui-kit/sheet";

/** Right slide-over drawer, built on the ui-kit Sheet. Esc closes; the overlay
 * click closes; onBeforeClose can veto (unsaved-changes guard). The veto works by
 * keeping the Sheet controlled-open: Radix routes Esc / overlay click through
 * onOpenChange, we run tryClose, and simply do nothing (stay open) when vetoed. */
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
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) tryClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
        style={{ width, maxWidth: "100vw" }}
        className="block w-auto gap-0 p-0 overflow-y-auto bg-paper border-line shadow-2xl max-w-none sm:max-w-none"
      >
        <SheetTitle className="sr-only">Details</SheetTitle>
        <div className="sticky top-0 z-10 bg-card border-b border-line px-6 py-3.5">{header}</div>
        <div className="px-6 py-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
