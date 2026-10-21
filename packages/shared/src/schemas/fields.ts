import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "../auth";
import { issue } from "./issue";

export const requiredText = (max: number) =>
  z.string().trim().min(1, issue("required")).max(max, issue("too_long"));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email(issue("invalid_email")));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, issue("password_too_short"))
  .max(256, issue("too_long"));
