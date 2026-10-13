// Sign-in buttons styled after each provider's own branding: Google's "Sign in with Google"
// guidelines (white/dark fill, #747775 outline, Roboto Medium, multicolour G), Facebook's
// blue Login button and GitHub's dark button with the Invertocat mark.

function GoogleMark() {
  return (
    <svg viewBox="0 0 120 120" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M117.6 61.36c0-4.25-.38-8.34-1.09-12.27H60v23.21h32.29c-1.39 7.5-5.62 13.85-11.97 18.11v15.06h19.39c11.35-10.45 17.89-25.83 17.89-44.11z" />
      <path fill="#34A853" d="M60 120c16.2 0 29.78-5.37 39.71-14.54L80.32 90.41c-5.37 3.6-12.25 5.73-20.32 5.73-15.63 0-28.85-10.55-33.57-24.74H6.38v15.55C16.25 106.55 36.55 120 60 120z" />
      <path fill="#FBBC05" d="M26.43 71.4c-1.2-3.6-1.88-7.45-1.88-11.4s.68-7.8 1.88-11.4V33.05H6.38C2.32 41.15 0 50.32 0 60s2.32 18.85 6.38 26.95L26.43 71.4z" />
      <path fill="#EA4335" d="M60 23.86c8.81 0 16.72 3.03 22.94 8.98l17.21-17.21C89.75 5.95 76.17 0 60 0 36.55 0 16.25 13.45 6.38 33.05L26.43 48.6c4.72-14.18 17.94-24.74 33.57-24.74z" />
    </svg>
  );
}

function FacebookMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function KeyMark() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="7" cy="10" r="3.5" />
      <path d="M10.5 10h7M15 10v3M17.5 10v2" />
    </svg>
  );
}

const STYLES = {
  google: { className: "beta-provider-btn beta-provider-btn--google", Mark: GoogleMark, verb: "Sign in with" },
  facebook: { className: "beta-provider-btn beta-provider-btn--facebook", Mark: FacebookMark, verb: "Continue with" },
  github: { className: "beta-provider-btn beta-provider-btn--github", Mark: GitHubMark, verb: "Sign in with" }
};

export default function ProviderButton({ provider, disabled, onClick, verb }) {
  const style = STYLES[provider.kind] || { className: "beta-provider-btn beta-provider-btn--generic", Mark: KeyMark, verb: "Continue with" };
  const { Mark } = style;
  const label = provider.kind in STYLES
    ? { google: "Google", facebook: "Facebook", github: "GitHub" }[provider.kind]
    : provider.displayName || provider.id;
  return (
    <button type="button" className={style.className} disabled={disabled} onClick={onClick}>
      <span className="beta-provider-btn-mark"><Mark /></span>
      <span className="beta-provider-btn-label">{verb || style.verb} {label}</span>
    </button>
  );
}
