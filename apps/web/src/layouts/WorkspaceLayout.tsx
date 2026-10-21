import { Outlet, useMatch } from "react-router";
import { Logo } from "@/components/Logo";
import { OfficeNav } from "@/features/workspace/OfficeNav";
import { useLiveEvents } from "@/lib/live-events";
import { useSetupStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { HeaderActions } from "./HeaderActions";

// `registry:5000/orlok:2026.10.05` → `v2026.10.05`. A reference with no tag is shown whole,
// and a tag that already announces itself as a version is not given a second v.
function imageTag(reference: string) {
  const colon = reference.lastIndexOf(":");
  if (colon <= reference.lastIndexOf("/")) {
    return reference;
  }
  const tag = reference.slice(colon + 1);
  return /^v\d/.test(tag) ? tag : `v${tag}`;
}

// Offices and colleagues on the left, the selected view on the right. On small screens the
// list and the selected view (conversation, wiki or account) are shown one at a time.
export function WorkspaceLayout() {
  const { data: status } = useSetupStatus();
  useLiveEvents();
  const inColleague = useMatch("/colleagues/*") !== null;
  const inWiki = useMatch("/offices/*") !== null;
  const inAccount = useMatch("/account") !== null;
  const inConversation = inColleague || inWiki || inAccount;

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col bg-sidebar md:flex md:w-72 md:shrink-0 md:border-r",
          inConversation ? "hidden" : "flex flex-1 md:flex-none",
        )}
      >
        <div className="p-4">
          <Logo subtitle={status?.companyName} />
        </div>
        <OfficeNav />
        <div className="border-t p-3 md:hidden">
          <HeaderActions side="top" />
        </div>
        {/* Which build is on screen: the question a screenshot cannot answer. */}
        {status?.version ? (
          <p className="px-4 pb-3 text-center text-xs text-muted-foreground" title={status.version}>
            {imageTag(status.version)}
          </p>
        ) : null}
      </aside>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          inConversation ? "flex" : "hidden md:flex",
        )}
      >
        <Outlet />
      </div>
    </div>
  );
}
