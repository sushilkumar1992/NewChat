import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { getCurrentUser, signIn, confirmSignIn, signOut } from "aws-amplify/auth";

// Tracks the Cognito auth state and exposes login / new-password / logout.
// status: "loading" (checking existing session) | "signedOut" | "signedIn".
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [status, setStatus] = useState("loading");
  const [email, setEmail] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const u = await getCurrentUser();
      setEmail(u?.signInDetails?.loginId || u?.username || null);
      setStatus("signedIn");
    } catch {
      setEmail(null);
      setStatus("signedOut");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Returns the Amplify signIn result so the login page can handle the
  // "new password required" challenge that admin-created users hit on first login.
  const login = useCallback((username, password) => signIn({ username, password }), []);
  const completeNewPassword = useCallback((newPassword) => confirmSignIn({ challengeResponse: newPassword }), []);

  const logout = useCallback(async () => {
    try { await signOut(); } finally { setEmail(null); setStatus("signedOut"); }
  }, []);

  return (
    <AuthContext.Provider value={{ status, email, login, completeNewPassword, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
