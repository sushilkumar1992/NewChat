import { useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

// Custom in-app login page. Admin-created Cognito users arrive in FORCE_CHANGE_PASSWORD state,
// so the first sign-in returns a "new password required" challenge — this page handles that
// second step inline (no Cognito Hosted UI / redirect).
export default function LoginPage() {
  const { login, completeNewPassword, refresh } = useAuth();
  const [phase, setPhase] = useState("login"); // "login" | "newPassword"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submitLogin(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const res = await login(email.trim().toLowerCase(), password);
      if (res.isSignedIn) { await refresh(); return; }
      const step = res.nextStep?.signInStep;
      if (step === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
        setPhase("newPassword");
      } else {
        setErr("Unsupported sign-in step: " + step + ". Contact your administrator.");
      }
    } catch (e2) {
      setErr(friendly(e2));
    } finally {
      setBusy(false);
    }
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    setErr("");
    if (newPassword !== confirmPw) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      const res = await completeNewPassword(newPassword);
      if (res.isSignedIn) { await refresh(); return; }
      setErr("Could not set the new password. Please try again.");
    } catch (e2) {
      setErr(friendly(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={phase === "login" ? submitLogin : submitNewPassword}>
        <div className="auth__brand">
          <img src="/assets/personal-icon.svg" alt="" onError={(e) => (e.target.style.display = "none")} />
          <div>
            <div className="auth__title">Personal</div>
            <div className="auth__sub">Sign in to your assistant</div>
          </div>
        </div>

        {phase === "login" ? (
          <>
            <label className="auth__label">Email
              <input className="auth__input" type="email" autoComplete="username" required
                     value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label className="auth__label">Password
              <input className="auth__input" type="password" autoComplete="current-password" required
                     value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
            </label>
          </>
        ) : (
          <>
            <p className="auth__note">First sign-in — please set a new password.</p>
            <label className="auth__label">New password
              <input className="auth__input" type="password" autoComplete="new-password" required
                     value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" />
            </label>
            <label className="auth__label">Confirm new password
              <input className="auth__input" type="password" autoComplete="new-password" required
                     value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Re-enter new password" />
            </label>
          </>
        )}

        {err && <div className="auth__err">{err}</div>}

        <button className="auth__btn" type="submit" disabled={busy}>
          {busy ? "Please wait…" : phase === "login" ? "Sign in" : "Set password & continue"}
        </button>

        <div className="auth__hint">Accounts are created by your administrator.</div>
      </form>
    </div>
  );
}

function friendly(e) {
  const name = e?.name || "";
  if (name === "NotAuthorizedException") return "Incorrect email or password.";
  if (name === "UserNotFoundException") return "Incorrect email or password.";
  if (name === "PasswordResetRequiredException") return "Password reset required — contact your administrator.";
  if (name === "InvalidPasswordException") return e.message || "Password does not meet the requirements.";
  if (name === "LimitExceededException") return "Too many attempts. Please wait a moment and try again.";
  return e?.message || "Sign in failed. Please try again.";
}
