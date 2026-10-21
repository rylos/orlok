import type { LiveEvent } from "@orlok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { workspaceKeys } from "./workspace-queries";

// The conversation whose answer this page is streaming: it reloads itself when the stream ends,
// and reloading it halfway would show the answer twice for a moment.
let streamingConversation: string | null = null;

export function setStreamingConversation(id: string | null) {
  streamingConversation = id;
}

// Follows what changes for the person elsewhere — a message sent from Telegram, an answer after
// a late approval, a conversation created or deleted in another tab or chat — so the open page
// shows it without a reload (R-CHAT-13). A page showing a conversation that starts answering
// picks up the stream by itself once the conversation reads as running.
export function useLiveEvents() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    const source = new EventSource("/api/me/events");
    let connectedBefore = false;
    source.addEventListener("ready", () => {
      // Back after a dropped connection: whatever changed meanwhile was not heard, decisions on
      // commands included, which nothing asks for again on its own.
      if (connectedBefore) {
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
        void queryClient.invalidateQueries({ queryKey: ["ops"] });
      }
      connectedBefore = true;
    });
    source.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      if (event.type !== "conversation") {
        return;
      }
      const { colleagueId, conversationId } = event;
      if (event.deleted && conversationId) {
        queryClient.removeQueries({ queryKey: workspaceKeys.conversation(conversationId) });
        const open = `/colleagues/${colleagueId}/${conversationId}`;
        if (pathRef.current === open || pathRef.current.startsWith(`${open}/`)) {
          navigate(`/colleagues/${colleagueId}`, { replace: true, state: { fresh: true } });
        }
      } else if (conversationId && conversationId !== streamingConversation) {
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversation(conversationId),
        });
      }
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(colleagueId) });
      // Commands decided or run elsewhere: their cards and the approval dock follow.
      void queryClient.invalidateQueries({ queryKey: ["ops"] });
    };
    return () => source.close();
  }, [queryClient, navigate]);
}
