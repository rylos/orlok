import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Input } from "./input";

export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input type={visible ? "text" : "password"} className={cn("pr-10", className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
