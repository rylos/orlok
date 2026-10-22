import type { Locale } from "@orlok/shared";

// Transactional emails in every supported language (R-I18N-3).

export type Email = { subject: string; text: string; html: string };

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render(
  paragraphs: string[],
  footer: string,
  action?: { label: string; url: string },
): Email["html"] {
  const body = paragraphs
    .map((text) => `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`)
    .join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#8839ef;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#5c5f77;word-break:break-all">${escapeHtml(action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#eff1f5;font-family:system-ui,sans-serif;color:#4c4f69"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px"><p style="margin:0 0 20px;font-weight:700;font-size:18px">Orlok</p>${body}${button}<p style="margin:24px 0 0;font-size:13px;color:#5c5f77">${escapeHtml(footer)}</p></div></body></html>`;
}

export type InvitationEmailParams = {
  locale: Locale;
  companyName: string | null;
  inviterName: string | null;
  inviteUrl: string;
  expiresAt: Date;
};

export function invitationEmail(params: InvitationEmailParams): Email {
  const workspace = params.companyName ?? "Orlok";
  const date = params.expiresAt.toLocaleDateString(params.locale, { dateStyle: "long" });
  const copy =
    params.locale === "it"
      ? {
          subject: `Invito a ${workspace} su Orlok`,
          lines: [
            `${params.inviterName ?? "Un amministratore"} ti ha invitato su Orlok per ${workspace}, dove lavori con i colleghi virtuali.`,
            `Accetta l'invito per creare il tuo account. Il link scade il ${date}.`,
          ],
          action: "Accetta l'invito",
          footer: "Se non aspettavi questa email puoi ignorarla.",
        }
      : {
          subject: `You are invited to ${workspace} on Orlok`,
          lines: [
            `${params.inviterName ?? "An administrator"} invited you to ${workspace} on Orlok, where you work with virtual colleagues.`,
            `Accept the invitation to create your account. The link expires on ${date}.`,
          ],
          action: "Accept invitation",
          footer: "If you were not expecting this email, you can ignore it.",
        };

  return {
    subject: copy.subject,
    text: [...copy.lines, "", `${copy.action}: ${params.inviteUrl}`, "", copy.footer].join("\n"),
    html: render(copy.lines, copy.footer, { label: copy.action, url: params.inviteUrl }),
  };
}

export type PasswordResetEmailParams = {
  locale: Locale;
  companyName: string | null;
  adminName: string;
  resetUrl: string;
  hours: number;
};

// A link to choose a new password, created by an administrator (R-AUTH-7).
export function passwordResetEmail(params: PasswordResetEmailParams): Email {
  const workspace = params.companyName ?? "Orlok";
  const copy =
    params.locale === "it"
      ? {
          subject: `Nuova password per ${workspace} su Orlok`,
          lines: [
            `${params.adminName} ha reimpostato la tua password di Orlok per ${workspace} e ha chiuso le tue sessioni su tutti i dispositivi.`,
            `Scegli una nuova password dal link qui sotto, valido ${params.hours} ore e utilizzabile una volta sola.`,
          ],
          action: "Scegli la nuova password",
          footer:
            "Se non ti aspettavi questa email, contatta un amministratore. La password attuale resta valida finché non ne scegli una nuova.",
        }
      : {
          subject: `New password for ${workspace} on Orlok`,
          lines: [
            `${params.adminName} reset your Orlok password for ${workspace}: you were signed out on every device.`,
            `Choose a new password from the link below. It works once, for ${params.hours} hours.`,
          ],
          action: "Choose a new password",
          footer:
            "If you were not expecting this email, contact an administrator. Your current password keeps working until you choose a new one.",
        };

  return {
    subject: copy.subject,
    text: [...copy.lines, "", `${copy.action}: ${params.resetUrl}`, "", copy.footer].join("\n"),
    html: render(copy.lines, copy.footer, { label: copy.action, url: params.resetUrl }),
  };
}

// How a password was changed: from a reset link, by the server command, or from Account.
export type PasswordChange = "link" | "server" | "account";

export type PasswordChangedEmailParams = {
  locale: Locale;
  companyName: string | null;
  email: string;
  how: PasswordChange;
};

// Security notice after any password change, so a change the person did not make does not go
// unnoticed (R-AUTH-7). No link inside: it only informs.
export function passwordChangedEmail(params: PasswordChangedEmailParams): Email {
  const workspace = params.companyName ?? "Orlok";
  const copy =
    params.locale === "it"
      ? {
          subject: "La password del tuo account Orlok è stata modificata",
          lines: [
            `Ti confermiamo che la password del tuo account Orlok per ${workspace} (${params.email}) è stata modificata.`,
            {
              link: "La modifica è stata effettuata tramite il link di reimpostazione inviato da un amministratore. Le sessioni aperte in precedenza sono state chiuse.",
              server:
                "La password è stata reimpostata da un amministratore direttamente sul server e tutte le sessioni aperte sono state chiuse. Dopo il primo accesso con la password temporanea, ti invitiamo a sostituirla da Account → Password.",
              account:
                "La modifica è stata effettuata dalla pagina Account. Le sessioni aperte sugli altri dispositivi sono state chiuse.",
            }[params.how],
            `Se non hai richiesto tu questa modifica, contatta immediatamente un amministratore di ${workspace}.`,
          ],
          footer: "Questo è un avviso automatico per la sicurezza del tuo account.",
        }
      : {
          subject: "Your Orlok password has been changed",
          lines: [
            `This is to confirm that the password of your Orlok account for ${workspace} (${params.email}) has been changed.`,
            {
              link: "The change was made with the password reset link sent by an administrator. Sessions opened before have been signed out.",
              server:
                "The password was reset by an administrator directly on the server and every session has been signed out. After signing in with the temporary password, please replace it from Account → Password.",
              account:
                "The change was made from the Account page. Sessions on other devices have been signed out.",
            }[params.how],
            `If you did not request this change, contact an administrator of ${workspace} immediately.`,
          ],
          footer: "This is an automated notice about the security of your account.",
        };

  return {
    subject: copy.subject,
    text: [...copy.lines, "", copy.footer].join("\n"),
    html: render(copy.lines, copy.footer),
  };
}

export function testEmail(locale: Locale): Email {
  const copy =
    locale === "it"
      ? {
          subject: "Email di prova di Orlok",
          line: "SMTP configurato correttamente: Orlok può inviare email.",
          footer: "Email inviata dalle impostazioni di amministrazione.",
        }
      : {
          subject: "Orlok test email",
          line: "SMTP is configured correctly: Orlok can send emails.",
          footer: "Sent from the administration settings.",
        };
  return {
    subject: copy.subject,
    text: `${copy.line}\n\n${copy.footer}`,
    html: render([copy.line], copy.footer),
  };
}

// Notifications (R-CHAT-7): the same copy is used for the email and the push notification.
export type Notice = Email & { pushTitle: string; pushBody: string };

function notice(
  copy: { subject: string; lines: string[]; action: string; footer: string },
  url: string,
  pushBody: string,
): Notice {
  return {
    subject: copy.subject,
    text: [...copy.lines, "", `${copy.action}: ${url}`, "", copy.footer].join("\n"),
    html: render(copy.lines, copy.footer, { label: copy.action, url }),
    pushTitle: copy.subject,
    pushBody: pushBody.length > 180 ? `${pushBody.slice(0, 179)}…` : pushBody,
  };
}

export type ApprovalNoticeParams = {
  locale: Locale;
  colleagueName: string;
  officeName: string;
  what: string;
  reason: string;
  url: string;
};

export function approvalNotice(params: ApprovalNoticeParams): Notice {
  const copy =
    params.locale === "it"
      ? {
          subject: `${params.colleagueName} chiede un'approvazione`,
          lines: [
            `${params.colleagueName} (${params.officeName}) vuole eseguire un'operazione che richiede un'approvazione:`,
            params.what,
            `Motivo: ${params.reason}`,
          ],
          action: "Apri la conversazione",
          footer:
            "Ricevi questa email perché l'operazione nasce da una tua conversazione. Puoi disattivarla dal tuo account in Orlok.",
        }
      : {
          subject: `${params.colleagueName} asks for approval`,
          lines: [
            `${params.colleagueName} (${params.officeName}) wants to run an operation that needs approval:`,
            params.what,
            `Reason: ${params.reason}`,
          ],
          action: "Open the conversation",
          footer:
            "You receive this email because you can approve operations of this office. You can turn it off in your Orlok account.",
        };
  return notice(copy, params.url, params.what);
}

export type FinishedNoticeParams = {
  locale: Locale;
  colleagueName: string;
  what: string;
  success: boolean;
  url: string;
};

export function finishedNotice(params: FinishedNoticeParams): Notice {
  const copy =
    params.locale === "it"
      ? {
          subject: params.success
            ? `${params.colleagueName}: intervento completato`
            : `${params.colleagueName}: intervento non riuscito`,
          lines: [
            params.success
              ? `L'operazione che avevi chiesto è stata completata: ${params.what}`
              : `L'operazione che avevi chiesto si è conclusa con un problema: ${params.what}`,
            `${params.colleagueName} ti riporta il risultato nella conversazione.`,
          ],
          action: "Apri la conversazione",
          footer: "Puoi disattivare queste notifiche dal tuo account in Orlok.",
        }
      : {
          subject: params.success
            ? `${params.colleagueName}: intervention completed`
            : `${params.colleagueName}: intervention failed`,
          lines: [
            params.success
              ? `The operation you asked for has been completed: ${params.what}`
              : `The operation you asked for ended with a problem: ${params.what}`,
            `${params.colleagueName} reports the result in the conversation.`,
          ],
          action: "Open the conversation",
          footer: "You can turn these notifications off in your Orlok account.",
        };
  return notice(copy, params.url, params.what);
}

type BudgetNoticeParams = {
  locale: Locale;
  // What the limit is on: the installation, an office or a person, already named.
  scopeName: string;
  spent: string;
  limit: string;
  exceeded: boolean;
  url: string;
};

// To administrators, once a month per limit (R-MOD-4).
export function budgetNotice(params: BudgetNoticeParams): Notice {
  const copy =
    params.locale === "it"
      ? {
          subject: params.exceeded
            ? `Orlok: limite di spesa raggiunto (${params.scopeName})`
            : `Orlok: spesa vicina al limite (${params.scopeName})`,
          lines: [
            `Spesa del mese per ${params.scopeName}: ${params.spent} su un limite di ${params.limit}.`,
            params.exceeded
              ? "I colleghi non chiamano più il modello per questo limite fino al mese prossimo, a meno che il limite venga alzato."
              : "Al raggiungimento del limite i colleghi smettono di chiamare il modello fino al mese prossimo.",
          ],
          action: "Apri i costi",
          footer: "Ricevi questo avviso perché sei amministratore di Orlok.",
        }
      : {
          subject: params.exceeded
            ? `Orlok: spending limit reached (${params.scopeName})`
            : `Orlok: spending close to the limit (${params.scopeName})`,
          lines: [
            `This month's spend for ${params.scopeName}: ${params.spent} of a ${params.limit} limit.`,
            params.exceeded
              ? "Colleagues no longer call the model under this limit until next month, unless the limit is raised."
              : "When the limit is reached, colleagues stop calling the model until next month.",
          ],
          action: "Open costs",
          footer: "You receive this notice because you are an Orlok administrator.",
        };
  return notice(copy, params.url, `${params.spent} / ${params.limit}`);
}
