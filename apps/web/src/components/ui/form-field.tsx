import type { ReactNode } from "react";

type FormFieldProps = {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
};

// Label, control and message (error or hint) linked through ids.
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-message`} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-message`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
