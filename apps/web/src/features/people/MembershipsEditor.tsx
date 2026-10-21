import { isOfficeRole, OFFICE_ROLES, type OfficeMembership } from "@orlok/shared";
import { useTranslation } from "react-i18next";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Select } from "@/components/ui/select";

type MembershipsEditorProps = {
  idPrefix: string;
  offices: { id: string; name: string }[];
  value: OfficeMembership[];
  onChange: (value: OfficeMembership[]) => void;
};

// Offices a person works in, with their role in each office.
export function MembershipsEditor({ idPrefix, offices, value, onChange }: MembershipsEditorProps) {
  const { t } = useTranslation();

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t("people.offices")}</legend>
      {offices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("people.noOffices")}</p>
      ) : (
        <>
          <ul className="divide-y rounded-md border bg-background">
            {offices.map((office) => {
              const membership = value.find((item) => item.officeId === office.id);
              const selectId = `${idPrefix}-${office.id}-role`;
              return (
                <li
                  key={office.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <CheckboxField
                    label={office.name}
                    checked={Boolean(membership)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...value, { officeId: office.id, role: "member" }]
                          : value.filter((item) => item.officeId !== office.id),
                      )
                    }
                  />
                  {membership ? (
                    <div className="w-44">
                      <label htmlFor={selectId} className="sr-only">
                        {t("people.officeRole")}
                      </label>
                      <Select
                        id={selectId}
                        value={membership.role}
                        onChange={(event) => {
                          const role = event.target.value;
                          if (isOfficeRole(role)) {
                            onChange(
                              value.map((item) =>
                                item.officeId === office.id ? { ...item, role } : item,
                              ),
                            );
                          }
                        }}
                      >
                        {OFFICE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`people.officeRoles.${role}`)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t("people.officeRolesHint")}</p>
        </>
      )}
    </fieldset>
  );
}
