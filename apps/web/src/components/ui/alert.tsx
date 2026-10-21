import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-foreground"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
