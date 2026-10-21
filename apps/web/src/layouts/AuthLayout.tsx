import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocaleSwitcher } from "@/i18n/LocaleSwitcher";
import { ThemeSwitcher } from "@/theme/ThemeSwitcher";

type AuthLayoutProps = {
  title: string;
  description: string;
  subtitle?: string | null;
  children: ReactNode;
};

export function AuthLayout({ title, description, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="relative min-h-dvh bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_60%)]">
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <LocaleSwitcher />
        <ThemeSwitcher />
      </div>
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-20">
        <Logo subtitle={subtitle} className="mb-6 self-center" />
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </main>
    </div>
  );
}
