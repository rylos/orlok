import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const variants = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  outline: "border bg-background hover:bg-accent hover:text-accent-foreground",
  ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  destructive: "text-destructive hover:bg-destructive/10",
} as const;

const sizes = {
  md: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-sm",
  icon: "size-9",
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

// Shared with links styled as buttons.
export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md") {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4",
    variants[variant],
    sizes[size],
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={cn(buttonClasses(variant, size), className)} {...props} />;
}
