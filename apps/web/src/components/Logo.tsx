import { cn } from "@/lib/utils";

export function Logo({ subtitle, className }: { subtitle?: string | null; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {/* The bat mascot, the same drawing as the app icon and the site; the name is beside it. */}
      <img src="/icons/icon.svg" alt="" className="size-9 shrink-0 rounded-lg" />
      <div className="leading-tight">
        <div className="font-semibold">Orlok</div>
        {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>
    </div>
  );
}
