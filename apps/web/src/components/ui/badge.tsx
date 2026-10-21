import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const variants = {
  neutral: "bg-muted text-muted-foreground",
  primary: "border-primary/40 bg-primary/15 text-foreground",
  success: "border-success/40 bg-success/15 text-foreground",
  warning: "border-warning/60 bg-warning/15 text-foreground",
  info: "border-info/50 bg-info/15 text-foreground",
} as const;

type BadgeProps = ComponentProps<"span"> & { variant?: keyof typeof variants };

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
