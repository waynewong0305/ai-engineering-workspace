/**
 * Files a worktree diff must never forward automatically — to a review prompt, an evidence item,
 * or a pre-PR report — per PROJECT_SPEC.md §11 ("Sensitive information protection"). This is a
 * deny list on file *paths*, distinct from packages/agents/src/environment.ts's deny list on
 * environment *variable names*; the two protect different channels and are deliberately separate.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env$/, // .env
  /(^|\/)\.env\.[^/]+$/, // .env.*
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, // SSH private keys (and their less-sensitive .pub twin, excluded too rather than special-cased)
  /(^|\/)\.ssh\//, // anything under a .ssh directory
  /\.pem$/, // PEM-encoded private keys
  /(^|\/)\.aws\/(credentials|config)$/, // AWS credentials
  /(^|\/).*\.keychain(-db)?$/, // macOS keychain data
  /(^|\/)Library\/Keychains\//, // macOS keychain data
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
