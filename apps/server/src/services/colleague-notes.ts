import { COLLEAGUE_NOTES_MAX } from "@orlok/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { colleagues } from "../db/schema";
import { type AgentTool, ToolInputError } from "./agent";
import { findLikelySecret } from "./secrets";

// The colleague's private notes about working with its owner (R-MEM-2): rewritten whole, short,
// never with secrets. The owner reads and edits them in the colleague's settings.
const notesInput = z.object({ content: z.string().max(COLLEAGUE_NOTES_MAX) });

export function createNotesTool(db: Db, colleagueId: string): AgentTool {
  return {
    name: "notes_write",
    description: `Replaces your private notes about working with this person (shown to you at the start of every conversation with them, and to them in your settings). Keep lasting preferences and working context only: how they like answers, what they look after, recurring situations. Write the whole notes, at most ${COLLEAGUE_NOTES_MAX} characters, keeping what still holds. Office knowledge belongs in the wiki; never write secrets.`,
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "The complete notes, Markdown" } },
      required: ["content"],
    },
    async run(input) {
      const parsed = notesInput.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(
          `Not saved: the notes must be text of at most ${COLLEAGUE_NOTES_MAX} characters. Shorten them, keeping what matters most.`,
        );
      }
      const secret = findLikelySecret(parsed.data.content);
      if (secret) {
        throw new ToolInputError(
          `Not saved: line ${secret.line} seems to contain ${secret.kind}. Never keep secrets in your notes.`,
        );
      }
      await db
        .update(colleagues)
        .set({ notes: parsed.data.content.trim(), updatedAt: new Date() })
        .where(eq(colleagues.id, colleagueId));
      return "Notes saved.";
    },
  };
}
