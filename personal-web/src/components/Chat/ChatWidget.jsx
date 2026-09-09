import ChatHeader from "./ChatHeader.jsx";
import MessageList from "./MessageList.jsx";
import Suggestions from "./Suggestions.jsx";
import Composer from "./Composer.jsx";

export default function ChatWidget({ open, chat, onClose }) {
  return (
    <div className={"popup" + (open ? " open" : "")}>
      <button className="popup__close" title="Close" onClick={onClose}>✕</button>
      <div style={{ height: "100%" }}>
        <div className="chat">
          <ChatHeader onEnd={chat.endChat} ended={chat.ended} />
          <MessageList
            messages={chat.messages}
            feedbackOpen={chat.feedbackOpen}
            onSubmitFeedback={chat.submitFeedback}
            onRestart={chat.startNew}
            onRate={chat.rateMessage}
          />
          <Suggestions onPick={chat.sendSuggestion} disabled={chat.busy || chat.ended} />
          <Composer onSend={chat.sendText} disabled={chat.busy || chat.ended} />
          <div className="chat__disclaimer">This feature uses AI</div>
        </div>
      </div>
    </div>
  );
}
