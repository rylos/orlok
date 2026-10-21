import type { IssueCode } from "../errors";

// Schema messages are issue codes (R-I18N-4): translation happens in the client.
export const issue = (code: IssueCode) => ({ error: code });
