import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProfileCard } from "@/features/profiles/ProfileCard";
import { ProfileForm } from "@/features/profiles/ProfileForm";
import { translateError } from "@/i18n/errors";
import { useProfiles, useProviders } from "@/lib/admin-queries";

// Colleague profiles: a model and a mode, granted to people (R-MOD-2).
export function ProfilesPage() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const providers = useProviders();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const providerList = providers.data ?? [];
  const providerById = new Map(providerList.map((provider) => [provider.id, provider]));
  const canCreate = providerList.length > 0;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("profiles.title")}</h1>
          <p className="text-muted-foreground">{t("profiles.description")}</p>
        </div>
        {creating || !canCreate ? null : (
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setEditingId(null);
            }}
          >
            <Plus aria-hidden />
            {t("profiles.add")}
          </Button>
        )}
      </div>

      {creating ? (
        <Card className="p-4">
          <ProfileForm providers={providerList} onDone={() => setCreating(false)} />
        </Card>
      ) : null}

      {profiles.isPending || providers.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : profiles.isError ? (
        <ErrorAlert>{translateError(t, profiles.error)}</ErrorAlert>
      ) : profiles.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {canCreate ? t("profiles.empty") : t("profiles.needProvider")}
          </p>
        )
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {profiles.data.map((profile) => (
            <li key={profile.id} className={editingId === profile.id ? "md:col-span-2" : undefined}>
              {editingId === profile.id ? (
                <Card className="p-4">
                  <ProfileForm
                    profile={profile}
                    providers={providerList}
                    onDone={() => setEditingId(null)}
                  />
                </Card>
              ) : (
                <ProfileCard
                  profile={profile}
                  provider={providerById.get(profile.providerId)}
                  onEdit={() => {
                    setEditingId(profile.id);
                    setCreating(false);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
