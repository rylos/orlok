import { Hono } from "hono";
import { requireAdmin } from "../../auth/middleware";
import type { AppEnv, Deps } from "../../types";
import { costRoutes } from "./costs";
import { documentRoutes } from "./documents";
import { embeddingRoutes } from "./embeddings";
import { invitationRoutes } from "./invitations";
import { mcpAdminRoutes } from "./mcp";
import { officeRoutes } from "./offices";
import { opsAdminRoutes } from "./ops";
import { peopleRoutes } from "./people";
import { playgroundRoutes } from "./playground";
import { profileRoutes } from "./profiles";
import { providerRoutes } from "./providers";
import { smtpRoutes } from "./smtp";
import { telegramRoutes } from "./telegram";
import { wikiSearchRoutes } from "./wiki-search";

export function adminRoutes(deps: Deps) {
  return new Hono<AppEnv>()
    .use(requireAdmin)
    .route("/offices", officeRoutes(deps))
    .route("/people", peopleRoutes(deps))
    .route("/invitations", invitationRoutes(deps))
    .route("/smtp", smtpRoutes(deps))
    .route("/telegram", telegramRoutes(deps))
    .route("/documents", documentRoutes(deps))
    .route("/wiki-search", wikiSearchRoutes(deps))
    .route("/embeddings", embeddingRoutes(deps))
    .route("/providers", providerRoutes(deps))
    .route("/profiles", profileRoutes(deps))
    .route("/playground", playgroundRoutes(deps))
    .route("/costs", costRoutes(deps))
    .route("/", opsAdminRoutes(deps))
    .route("/", mcpAdminRoutes(deps));
}
