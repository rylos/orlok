import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// A form in the admin pages takes the place of the row it edits, and a row is often one of many:
// this says which one is open, so nobody is left editing something they can no longer name.
export function FormHeading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />
      {children}
    </p>
  );
}
