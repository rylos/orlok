import { useTranslation } from "react-i18next";
import { DocumentsSection } from "@/features/models/DocumentsSection";
import { EmbeddingsSection } from "@/features/models/EmbeddingsSection";
import { Playground } from "@/features/models/Playground";
import { ProvidersSection } from "@/features/models/ProvidersSection";
import { WikiSearchSection } from "@/features/models/WikiSearchSection";

// Model administration (R-MOD-1): providers, documents, wiki search, semantic memory and the
// playground.
// Profiles have their own page (ProfilesPage).
export function ModelsPage() {
  const { t } = useTranslation();

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("models.title")}</h1>
        <p className="text-muted-foreground">{t("models.description")}</p>
      </div>
      <ProvidersSection />
      <DocumentsSection />
      <WikiSearchSection />
      <EmbeddingsSection />
      <Playground />
    </>
  );
}
