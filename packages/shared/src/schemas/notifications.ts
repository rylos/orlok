import { z } from "zod";
import { issue } from "./issue";

export const notificationSettingsSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  telegram: z.boolean().optional(),
});

// A bot token from @BotFather: "123456789:AA…".
export const telegramBotSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{5,20}:[A-Za-z0-9_-]{30,64}$/, issue("invalid_value")),
});

// PushSubscription.toJSON() of a browser.
export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/, error: "invalid_url" }).max(2_000, issue("too_long")),
  keys: z.object({
    p256dh: z.string().min(1, issue("required")).max(500, issue("too_long")),
    auth: z.string().min(1, issue("required")).max(200, issue("too_long")),
  }),
});

export const pushEndpointSchema = z.object({
  endpoint: z.string().min(1, issue("required")).max(2_000, issue("too_long")),
});
