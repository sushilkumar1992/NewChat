import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ConfigProvider } from "./context/ConfigContext.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { configureAuth } from "./services/auth.js";
import "./styles.css";

configureAuth(); // Amplify/Cognito must be configured before any auth call

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <ConfigProvider>
        <App />
      </ConfigProvider>
    </AuthProvider>
  </React.StrictMode>
);
