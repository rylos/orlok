// Notifications to people about approvals and finished interventions (R-CHAT-7), by email and
// web push on the devices they enabled.
export type NotificationSettings = {
  email: boolean;
  push: boolean;
  // Telegram, once an account is linked (R-CHAT-10).
  telegram: boolean;
  // Public VAPID key browsers need to subscribe to push notifications.
  vapidPublicKey: string;
  // Browsers subscribed to push notifications.
  devices: number;
};

// The installation's Telegram bot (R-CHAT-10), administrators only. The token never leaves the
// server.
export type TelegramBotSettings = { configured: boolean; botUsername: string | null };

// A person's Telegram link, from their account page.
export type TelegramLink = {
  // Whether the installation has a bot at all.
  available: boolean;
  botUsername: string | null;
  linked: boolean;
  username: string | null;
};
