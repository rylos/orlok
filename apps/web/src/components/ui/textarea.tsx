import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring/40",
        "aria-invalid:border-destructive disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
