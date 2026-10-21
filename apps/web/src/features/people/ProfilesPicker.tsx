import type { ModelProfile } from "@orlok/shared";
import { useTranslation } from "react-i18next";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { ModeBadge } from "@/features/profiles/ProfileCard";

type ProfilesPickerProps = {
  profiles: ModelProfile[];
  value: string[];
  onChange: (value: string[]) => void;
};

// Colleague profiles granted to a person: the ones their colleagues may use (R-MOD-2).
export function ProfilesPicker({ profiles, value, onChange }: ProfilesPickerProps) {
  const { t } = useTranslation();

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t("people.profiles")}</legend>
      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("people.noProfiles")}</p>
      ) : (
        <>
          <ul className="divide-y rounded-md border bg-background">
            {profiles.map((profile) => (
              <li
                key={profile.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <CheckboxField
                  label={profile.name}
                  checked={value.includes(profile.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, profile.id]
                        : value.filter((id) => id !== profile.id),
                    )
                  }
                />
                <ModeBadge mode={profile.mode} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("people.profilesHint")}</p>
        </>
      )}
    </fieldset>
  );
}
