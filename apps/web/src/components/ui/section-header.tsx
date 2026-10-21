import type { ReactNode } from "react";

type SectionHeaderProps = {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
};

export function SectionHeader({ id, title, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
