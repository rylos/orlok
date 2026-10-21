import type { ComponentProps, ReactNode } from "react";

type CheckboxFieldProps = Omit<ComponentProps<"input">, "type"> & { label: ReactNode };

export function CheckboxField({ label, ...props }: CheckboxFieldProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-primary" {...props} />
      {label}
    </label>
  );
}
