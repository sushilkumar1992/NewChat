// Floating launcher — a button with the Personal image. Hidden by the parent while the chat is open.
export default function Launcher({ onOpen }) {
  return (
    <button className="launcher" title="Chat with Personal" onClick={onOpen}>
      <img src="/assets/personal-icon.png" alt="Chat with Personal" />
      <span className="badge">1</span>
    </button>
  );
}
