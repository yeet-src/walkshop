/* The chat: the island, and nothing else. The conversation and the
 * blocks live in the isolate (lib/chat/); the page just mounts the
 * island that shows them. */
import Chat from "@/lib/Chat.jsx";

export default function ChatPage() {
  return <Chat />;
}
