import { useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

// In-app login page (Ritchie Bros. styling). Admin-created Cognito users arrive in
// FORCE_CHANGE_PASSWORD state, so the first sign-in returns a "new password required"
// challenge — this page handles that second step inline (no Cognito Hosted UI / redirect).
export default function LoginPage() {
  const { login, completeNewPassword, refresh } = useAuth();
  const [phase, setPhase] = useState("login"); // "login" | "newPassword"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
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

  const loginReady = email.trim() !== "" && password !== "";
  const newPwReady = newPassword !== "" && confirmPw !== "";
  const canSubmit = phase === "login" ? loginReady : newPwReady;

  return (
    <div className="rb-auth">
      <header className="rb-auth__header">
        <RbLogo />
      </header>

      <main className="rb-auth__main">
        <form
          className="rb-card"
          onSubmit={phase === "login" ? submitLogin : submitNewPassword}
        >
          <h1 className="rb-card__title">Welcome</h1>
          <p className="rb-card__sub">
            {phase === "login"
              ? "Sign in to your Ritchie Bros. account"
              : "Set a new password to finish signing in"}
          </p>

          {phase === "login" ? (
            <>
              <Field
                id="rb-email"
                label="Email address"
                type="email"
                autoComplete="username"
                value={email}
                onChange={setEmail}
              />
              <Field
                id="rb-password"
                label="Password"
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                toggle={{ shown: showPw, onToggle: () => setShowPw((s) => !s) }}
              />
            </>
          ) : (
            <>
              <Field
                id="rb-new-password"
                label="New password"
                type={showNewPw ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={setNewPassword}
                toggle={{ shown: showNewPw, onToggle: () => setShowNewPw((s) => !s) }}
              />
              <Field
                id="rb-confirm-password"
                label="Confirm new password"
                type={showNewPw ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPw}
                onChange={setConfirmPw}
              />
            </>
          )}

          {err && <div className="rb-card__err">{err}</div>}

          <button className="rb-btn" type="submit" disabled={busy || !canSubmit}>
            {busy ? "Please wait…" : phase === "login" ? "Sign in" : "Set password & continue"}
          </button>
        </form>
      </main>

      <footer className="rb-auth__footer">
        <span>© Ritchie Bros. Auctioneers. All rights reserved.</span>
        <span className="rb-auth__legal">
          <a href="#" onClick={(e) => e.preventDefault()}>General User Terms</a>
          <span className="rb-auth__sep">|</span>
          <a href="#" onClick={(e) => e.preventDefault()}>User Privacy Notice</a>
        </span>
      </footer>
    </div>
  );
}

// Outlined field with a floating label + optional password eye toggle.
function Field({ id, label, type, value, onChange, autoComplete, toggle }) {
  return (
    <div className={"rb-field" + (toggle ? " rb-field--pw" : "")}>
      <input
        id={id}
        className="rb-field__input"
        type={type}
        autoComplete={autoComplete}
        required
        placeholder=" "
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <label className="rb-field__label" htmlFor={id}>{label}</label>
      {toggle && (
        <button
          type="button"
          className="rb-field__eye"
          onClick={toggle.onToggle}
          aria-label={toggle.shown ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {toggle.shown ? <EyeOff /> : <Eye />}
        </button>
      )}
    </div>
  );
}

// Brand wordmark: uses the official SVG if present at /assets/ritchie-bros-logo.svg,
// otherwise falls back to a text wordmark so the page never renders logo-less.
function RbLogo() {
  const [imgOk, setImgOk] = useState(true);
  if (imgOk) {
    return (
      <img
        className="rb-logo"
        src="/assets/ritchie-bros-logo.svg"
        alt="Ritchie Bros."
        onError={() => setImgOk(false)}
      />
    );
  }
  return (
    <span className="rb-logo rb-logo--text">
      <span className="rb-logo__mark">rb</span>
      <span className="rb-logo__name">RITCHIE BROS.</span>
    </span>
  );
}

function Eye() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.3 9.3 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m2 2 20 20" />
    </svg>
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
