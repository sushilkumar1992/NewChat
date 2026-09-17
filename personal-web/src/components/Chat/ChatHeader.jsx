import { useConfig } from "../../context/ConfigContext.jsx";
import { useAuth } from "../../context/AuthContext.jsx";

export default function ChatHeader({ onEnd, ended }) {
  const config = useConfig();
  const { logout } = useAuth();
  return (
    <div className="chat__header">
      <img
        className="chat__avatar-img"
        src="/assets/personal-mark.png"
        alt="Personal"
        onError={(e) => {
          const d = document.createElement("div");
          d.className = "chat__avatar";
          d.textContent = "R";
          e.target.replaceWith(d);
        }}
      />
      <div>
        <div className="chat__title">{config.botName || "Assistant"}</div>
        <div className="chat__status">Online</div>
      </div>
      <div className="chat__header-actions">
        {!ended && (
          <button className="end-btn" title="End this chat and leave feedback" onClick={onEnd}>
            End chat
          </button>
        )}
        <button className="end-btn end-btn--signout" title="Sign out" onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
