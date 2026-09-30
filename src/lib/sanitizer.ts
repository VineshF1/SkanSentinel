/**
 * Secret sanitizer. Order matters (spec §5.5). Never throws.
 * Keeps only the last 64 KB of any log.
 */
const MAX_KEEP = 64 * 1024;

const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
// scheme://user:password@host
const URL_CREDS_RE =
  /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
// JWT: three base64url segments
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_=-]+\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/=]+/g;
const AWS_RE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;
const APIKEY_RE =
  /\b(sk_live_[A-Za-z0-9]+|sk_test_[A-Za-z0-9]+|rk_live_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[bpas]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g;
// name=value or name: value where name contains password|passwd|pwd|secret|token|auth|api key
// Bounded {0,64} quantifiers keep this linear-time on large inputs.
const KV_RE =
  /((?:["']?[\w.-]{0,64}?(?:password|passwd|pwd|secret|token|api key|api[_-]?key|auth)[\w.-]{0,64}?["']?)\s*[:=]\s*)(["']?)([^\s"'&;,}]+)\2/gi;

export function sanitizeText(input: unknown): string {
  try {
    if (input === null || input === undefined) return "";
    let s = String(input);
    // keep last 64KB first so regexes run on bounded input
    if (s.length > MAX_KEEP) s = s.slice(s.length - MAX_KEEP);
    s = s.replace(PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]");
    s = s.replace(URL_CREDS_RE, "$1[REDACTED_CREDENTIALS]@");
    s = s.replace(JWT_RE, "[REDACTED_JWT]");
    s = s.replace(BEARER_RE, "Bearer [REDACTED_TOKEN]");
    s = s.replace(AWS_RE, "[REDACTED_AWS_KEY]");
    s = s.replace(APIKEY_RE, "[REDACTED_API_KEY]");
    s = s.replace(KV_RE, "$1$2[REDACTED_SECRET]$2");
    if (s.length > MAX_KEEP) s = s.slice(s.length - MAX_KEEP);
    return s;
  } catch {
    return "[output withheld: sanitizer error]";
  }
}

/** Last 32 KB slice for exec helper / ping output before sanitize. */
export function tail32k(s: string): string {
  const n = 32 * 1024;
  return s.length > n ? s.slice(s.length - n) : s;
}
