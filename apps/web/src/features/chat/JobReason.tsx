import { explainReason, type OpsReasonExplanation } from "@orlok/shared";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

type Frame = "chat.ops.needsApproval" | "chat.ops.onceOnly" | "chat.ops.refused";

function explanationText(t: TFunction, explanation: OpsReasonExplanation): string {
  const { code, params, because } = explanation;
  const list = params.list?.split(", ").join("`, `");
  const text = t(`chat.ops.reasons.${code}`, { ...params, ...(list ? { list } : {}) });
  return because ? `${text} (${explanationText(t, because)})` : text;
}

// Why a command waits for approval or was refused, in the person's language (R-OPS-4): the
// classifier's English text when no code explains it, as for a reason added later. Program
// names, types and paths between backticks show as code.
export function JobReason({ frame, reason }: { frame: Frame; reason: string }) {
  const { t } = useTranslation();
  const explanation = explainReason(reason);
  const text = t(frame, { reason: explanation ? explanationText(t, explanation) : reason });
  return (
    <span>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
          <code key={i} className="font-mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}
