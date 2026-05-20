# UI integration recipes

Concrete patterns for the most common chat UI surfaces. Examples are
in React but the pattern translates to any framework — the only React-
specific parts are `useEffect` for listener cleanup and `useState`
for re-renders.

---

## Chat list

```tsx
function ChatList() {
  const [convs, setConvs] = useState<Conversation[]>([]);

  useEffect(() => {
    chat.listConversations().then(setConvs);
    const off = chat.on("conversationsChanged", () => {
      chat.listConversations().then(setConvs);
    });
    return off;
  }, []);

  return convs.map((c) => <ChatListRow key={c.peerUserId} conv={c} />);
}

function ChatListRow({ conv }: { conv: Conversation }) {
  const last = conv.lastMessage;
  const preview = last?.deletedAt != null
    ? <i>this message was deleted</i>
    : last?.text ?? "";
  const isMine = last?.senderUserId === chat.currentUserId;

  return (
    <div>
      <strong>{conv.peerUserId}</strong>
      {isMine && <StatusIcon status={last?.status} />}
      <span>{preview}</span>
      {last?.editedAt != null && <small>(edited)</small>}
      {conv.unreadCount > 0 && <Badge count={conv.unreadCount} />}
    </div>
  );
}
```

Notes:
- `conversationsChanged` fires for any state movement *and* for
  deletes (the deleted peer's id appears in `changed`; the
  conversation is already absent from `listConversations()`).
- `lastMessage` is `null` only if the row points to a missing
  MessageStore entry (shouldn't happen in practice — defensive).
- `lastMessage.status` exists only on rows you authored. Peer-
  authored rows omit it.

---

## Conversation view

```tsx
function ConversationView({ peerUserId }: { peerUserId: string }) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);

  useEffect(() => {
    // Load initial history. Use this on mount instead of relying on
    // `message` events — drainPending fires `message` synchronously
    // during connect, before any listener can attach.
    chat.getHistory(peerUserId, { limit: 50 }).then(setMessages);

    const off1 = chat.on("message", (e) => {
      if (e.peerUserId !== peerUserId) return;
      setMessages((prev) => [...prev, /* shape conversion */ ]);
    });
    const off2 = chat.on("messageEdited", (e) => {
      if (e.peerUserId !== peerUserId) return;
      setMessages((prev) => prev.map((m) =>
        m.id === e.targetId ? { ...m, text: e.newText, editedAt: e.editedAt } : m
      ));
    });
    const off3 = chat.on("messageDeleted", (e) => {
      if (e.peerUserId !== peerUserId) return;
      setMessages((prev) => prev.map((m) =>
        m.id === e.targetId ? { ...m, text: "", deletedAt: e.deletedAt } : m
      ));
    });
    const off4 = chat.on("conversationDeletedByPeer", (e) => {
      if (e.peerUserId === peerUserId) {
        // Navigate away; the chat no longer exists.
        navigate("/chats");
        toast(`${peerUserId} deleted the chat`);
      }
    });
    return () => { off1(); off2(); off3(); off4(); };
  }, [peerUserId]);

  // ... render messages, input box, etc.
}
```

---

## Message row — edited / deleted indicators

```tsx
function MessageRow({ msg, isMine }: { msg: StoredMessage; isMine: boolean }) {
  if (msg.deletedAt != null) {
    return (
      <div className="message message-deleted">
        <i>this message was deleted</i>
      </div>
    );
  }
  return (
    <div className="message">
      <span>{msg.text}</span>
      {msg.editedAt != null && <small className="edited-badge">edited</small>}
      {isMine && <StatusIcon status={msg.status} />}
    </div>
  );
}
```

`StoredMessage`'s `editedAt` / `deletedAt` are the source of truth.
Don't derive them from the events directly — the SDK persists them so
they survive reload.

---

## Edit / delete affordance gating

```tsx
import { EDIT_WINDOW_MS } from "@dtelecom/secure-chat-client";

function MessageActions({ msg }: { msg: StoredMessage }) {
  const isMine = msg.senderUserId === chat.currentUserId;
  const isLive = msg.deletedAt == null;
  const canEdit = isMine && isLive && Date.now() - msg.sentAt < EDIT_WINDOW_MS;
  const canDelete = isMine && isLive;

  // Re-render every minute so canEdit flips as the window passes.
  // (Cheap; only the actions menu has this hook.)
  useEffect(() => {
    const t = setInterval(() => forceUpdate(), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      {canEdit && <button onClick={onEdit}>Edit</button>}
      {canDelete && <button onClick={onDelete}>Delete</button>}
    </>
  );
}

async function onEdit() {
  const newText = prompt("New text", msg.text);
  if (!newText) return;
  try {
    await chat.editMessage(msg.peerUserId, msg.id, newText);
  } catch (err) {
    if (err instanceof ChatError && err.code === "edit_window_expired") {
      toast("Too late to edit this message");
    } else {
      toast("Edit failed");
    }
  }
}
```

The 24h check has to happen on the UI side too — without it the user
clicks "Edit", types, hits send, and gets a confusing
`edit_window_expired` error. The runtime check above gates the
affordance dynamically.

---

## Delete chat menu (delete-for-me vs delete-for-everyone)

```tsx
function ChatMenu({ peerUserId }: { peerUserId: string }) {
  return (
    <Dropdown>
      <DropdownItem onClick={() => confirmDeleteForMe(peerUserId)}>
        Delete chat for me
      </DropdownItem>
      <DropdownItem onClick={() => confirmDeleteForEveryone(peerUserId)}>
        Delete chat for everyone
      </DropdownItem>
    </Dropdown>
  );
}

async function confirmDeleteForMe(peerUserId: string) {
  if (!confirm("Delete this chat on all your devices? The other person keeps their copy.")) return;
  await chat.deleteConversationForMe(peerUserId);
  navigate("/chats");
}

async function confirmDeleteForEveryone(peerUserId: string) {
  if (!confirm("Delete this chat for everyone? This wipes both sides and can't be undone.")) return;
  try {
    await chat.deleteConversationForEveryone(peerUserId);
    navigate("/chats");
  } catch (err) {
    if (err instanceof ChatError && err.code === "peer_unreachable") {
      // The local wipe still happened — only the peer-side wipe didn't fire.
      toast("Chat deleted locally. The other person will still have a copy.");
      navigate("/chats");
    } else {
      toast("Delete failed");
    }
  }
}
```

**The semantic difference:**
- *Delete for me* — clears on every device of YOUR user. Peer keeps
  the thread. Future inbound from peer re-creates the chat. Doesn't
  signal the peer.
- *Delete for everyone* — clears on YOUR side AND on the peer's
  side. Peer's UI fires `conversationDeletedByPeer`. Future
  outbound from either side re-creates a fresh thread.

Both wipes are multi-device-consistent — the SDK self-echoes to your
siblings.

---

## Peer-deleted-the-chat handling

```tsx
useEffect(() => {
  const off = chat.on("conversationDeletedByPeer", (e) => {
    // The SDK has already wiped local state by the time this fires.
    if (currentlyOpenChat === e.peerUserId) {
      navigate("/chats");
    }
    toast(`${displayName(e.peerUserId)} deleted the chat`);
  });
  return off;
}, []);
```

The toast is optional — if the chat just disappears from the list
without explanation, users may think it's a bug.

---

## Typing indicator

```tsx
function TypingIndicator({ peerUserId }: { peerUserId: string }) {
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    let timeout: NodeJS.Timeout | undefined;
    const off = chat.on("typing", (e) => {
      if (e.peerUserId !== peerUserId) return;
      if (e.state === "started") {
        setTyping(true);
        // Auto-clear if peer drops without sending "stopped".
        clearTimeout(timeout);
        timeout = setTimeout(() => setTyping(false), 8_000);
      } else {
        setTyping(false);
        clearTimeout(timeout);
      }
    });
    return () => { off(); clearTimeout(timeout); };
  }, [peerUserId]);

  return typing ? <span>typing…</span> : null;
}

// Compose box
function onChangeText(text: string) {
  setText(text);
  chat.setTyping(peerUserId, text.length > 0);
}
function onSend() {
  chat.sendText(peerUserId, text);
  setText("");
  // Don't need to setTyping(false) — the SDK clears on send.
}
```

`setTyping` is fire-and-forget; it never throws.

---

## Status indicators (✓ / ✓✓ / Read)

```tsx
function StatusIcon({ status }: { status?: MessageStatus }) {
  switch (status) {
    case "pending":      return <ClockIcon />;
    case "sent":         return <SingleCheck />;
    case "delivered":    return <DoubleCheck />;
    case "deliveredAll": return <DoubleCheck />;
    case "read":         return <DoubleCheckBlue />;
    case "failed":       return <ErrorIcon onClick={onRetry} />;
    default:             return null; // inbound / unknown
  }
}

async function onRetry(msgId: string) {
  try {
    await chat.retrySend(msgId);
  } catch {
    toast("Retry failed");
  }
}
```

Status is mirrored into `StoredMessage.status` so the indicator
survives reload. Update via the `statusChange` event for live
transitions.

---

## Multi-tab "open elsewhere" overlay

```tsx
function App() {
  const [secondary, setSecondary] = useState(false);

  useEffect(() => {
    const off = chat.on("tabConflict", (e) => {
      setSecondary(e.role === "secondary");
    });
    return off;
  }, []);

  return (
    <>
      <ChatApp />
      {secondary && (
        <Overlay>
          <p>This chat is open in another tab.</p>
          <button onClick={() => chat.takeOver()}>Use here</button>
        </Overlay>
      )}
    </>
  );
}
```

`tabConflict` only fires on browsers with the Web Locks API; old
browsers or non-browser hosts behave as always-primary.

---

## Connection state indicator

```tsx
function ConnectionPill() {
  const [state, setState] = useState<ConnectionState>("connecting");
  useEffect(() => {
    const off = chat.on("connectionStateChange", (e) => setState(e.state));
    return off;
  }, []);
  if (state === "open") return null;
  return <Pill>{state}…</Pill>;
}
```

---

## Sign-out cleanup

```tsx
async function signOut() {
  const userId = chat.currentUserId;
  await chat.disconnect();
  if (userId) {
    await DTelecomSecureChat.wipeUserData(store, userId);
  }
  // Now safe to sign in as a different user on the same browser/device
  // — no cross-user data leak.
}
```

`wipeUserData` drops every key under the user's scope (`u/<userId>/`).
Different users on the same device are physically isolated.

---

## See also

- [`events.md`](events.md) — every event payload and when it fires
- [`errors.md`](errors.md) — every `ChatError.code` and recovery hint
- [`multi-device.md`](multi-device.md) — self-echo + sibling-device
  state convergence
