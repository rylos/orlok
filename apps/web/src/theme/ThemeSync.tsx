import { useEffect } from "react";
import { useMe } from "@/lib/queries";
import { useTheme } from "./ThemeProvider";

// After sign-in the theme stored in the profile wins over the device's local one (R-UI-3).
export function ThemeSync() {
  const { data: me } = useMe();
  const { setPreference } = useTheme();
  const serverPreference = me?.themePreference;

  useEffect(() => {
    if (serverPreference) {
      setPreference(serverPreference);
    }
  }, [serverPreference, setPreference]);

  return null;
}
