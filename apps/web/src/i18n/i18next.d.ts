import "i18next";
import type { Translation } from "./locales/en";

// Typed translation keys: a missing key is a compile-time error.
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: Translation };
  }
}
