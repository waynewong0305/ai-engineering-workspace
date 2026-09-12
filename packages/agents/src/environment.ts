const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

const SENSITIVE_KEY = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|DATABASE_URL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)|^(?:ANTHROPIC|AWS|AZURE|GCP|GOOGLE|OPENAI)_/i;

export class UnsafeEnvironmentError extends Error {}

export function sanitizeEnvironment(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new UnsafeEnvironmentError(`Environment variable ${key} is blocked because it may contain credentials.`);
    }
    if (!ALLOWED_ENVIRONMENT_KEYS.has(key)) {
      throw new UnsafeEnvironmentError(`Environment variable ${key} is not in the agent allowlist.`);
    }
    environment[key] = value;
  }

  environment.NO_COLOR = "1";
  environment.TERM = environment.TERM ?? "dumb";
  return environment;
}

