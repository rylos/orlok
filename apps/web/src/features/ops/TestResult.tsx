import { CheckCircle2, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import type { HostTestResult } from "@/lib/credential-queries";
import { translateTestError } from "./format";

// What a connection test answers, wherever it was started from: whether it got in, and the
// output, which says which account answered.
export function TestResult({ result }: { result: HostTestResult }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {result.ok ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {t("ops.hosts.testOk")}
        </p>
      ) : (
        <ErrorAlert>
          {t("ops.hosts.testFailed", { message: translateTestError(t, result.error) })}
        </ErrorAlert>
      )}
      {result.output ? (
        <details className="group rounded-md border bg-background">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
            {t("ops.hosts.testOutput")}
          </summary>
          <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
            {result.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
