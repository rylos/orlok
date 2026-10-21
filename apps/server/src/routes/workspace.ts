import { Hono } from "hono";
import { currentUser, requireUser } from "../auth/middleware";
import { listWorkspaceOffices } from "../services/offices";
import type { AppEnv, Deps } from "../types";

// What a signed-in person can work with: their offices and enabled colleagues.
export function workspaceRoutes({ db }: Deps) {
  return new Hono<AppEnv>()
    .use(requireUser)
    .get("/offices", async (c) => c.json(await listWorkspaceOffices(db, currentUser(c))));
}
