import { useEffect, useState } from "react";
import { useChat } from "./hooks/useChat.js";
import { LightboxProvider } from "./context/LightboxContext.jsx";
import Launcher from "./components/Home/Launcher.jsx";
import ChatWidget from "./components/Chat/ChatWidget.jsx";
import Lightbox from "./components/Chat/Lightbox.jsx";

const BACKGROUND_IMAGE = "/assets/background.jpg"; // "" for a plain white page

export default function App() {
  const chat = useChat();
  const [open, setOpen] = useState(false);

  const openWidget = () => {
    setOpen(true);
    chat.open();
  };
  const closeWidget = () => setOpen(false);

  // Set the page background (white fallback if the image is missing) — mirrors the vanilla probe.
  useEffect(() => {
    const home = document.getElementById("home");
    if (!home || !BACKGROUND_IMAGE) return;
    const img = new Image();
    img.onload = () => (home.style.backgroundImage = `url('${BACKGROUND_IMAGE}')`);
    img.onerror = () => (home.style.background = "#ffffff");
    img.src = BACKGROUND_IMAGE;
  }, []);

  return (
    <LightboxProvider>
      <div className="home" id="home" />

      {!open && <Launcher onOpen={openWidget} />}
      <ChatWidget open={open} chat={chat} onClose={closeWidget} />
      <Lightbox />
    </LightboxProvider>
  );
}
