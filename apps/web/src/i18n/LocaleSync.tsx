import { useEffect } from "react";
import { useMe, useSetupStatus } from "@/lib/queries";
import i18n, { hasPreferredLocale, setLocale } from ".";

// Keeps the language in sync: the user profile after sign-in, otherwise the installation
// default when neither the user nor the browser indicates one (R-I18N-2, R-I18N-3).
export function LocaleSync() {
  const { data: me } = useMe();
  const { data: status } = useSetupStatus();
  const profileLocale = me?.locale;
  const installationLocale = status?.defaultLocale;
  const signedOut = me === null;

  useEffect(() => {
    if (profileLocale) {
      setLocale(profileLocale);
    }
  }, [profileLocale]);

  useEffect(() => {
    if (signedOut && installationLocale && !hasPreferredLocale()) {
      void i18n.changeLanguage(installationLocale);
    }
  }, [signedOut, installationLocale]);

  return null;
}
