// Pure helpers for branch-scoped visual-plan tracking and bounded GitHub PR
// preview sections. No node: imports, no timers, no Buffer: web-standard JS
// only, so the Claude Code mod, the GitHub Copilot extension, and the Node CLI
// scripts share one contract.
import { isDocumentId } from "./listen-core.mjs";

export const PR_SECTION_START = "<!-- unpaged-plan:start -->";
export const PR_SECTION_END = "<!-- unpaged-plan:end -->";

export const PR_CREATE_COMMAND = /(^|[\s;&|(`])gh\s+pr\s+create\b/;
export const DRY_RUN_HEADER = /Would have created a Pull Request with:/;
export const GITHUB_PR_CREATE_TOOL =
  /^(?:mcp__)?[A-Za-z0-9_-]*github[A-Za-z0-9_-]*?(?:__|-)(create_pull_request|open_pull_request|pull_request_create|create_pr)$/i;
export const PR_URL_PATTERN = /https:\/\/[^\s"'<>)\]]+\/pull\/(\d+)/;

const SHELL_TOOLS = new Set(["Bash", "bash", "powershell", "local_shell"]);
const JOIN_PATH_PATTERN = /^\/join\/([A-Za-z0-9_-]{16,128})\/?$/;

export function isShellToolName(toolName) {
  return typeof toolName === "string" && SHELL_TOOLS.has(toolName);
}

/**
 * Parses a git `HEAD` file's text and returns the named branch, or `null` when
 * detached, malformed, or pointing outside `refs/heads/`.
 */
export function parseGitHeadBranch(rawHead) {
  if (typeof rawHead !== "string") return null;
  const trimmed = rawHead.trim();
  const prefix = "ref: refs/heads/";
  if (!trimmed.startsWith(prefix)) return null;
  const branch = trimmed.slice(prefix.length).trim();
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    /[\0-\x1f\x7f ~^:?*[\\]/.test(branch)
  ) {
    return null;
  }
  return branch;
}

/**
 * Resolves a `.git` worktree pointer file (`gitdir: <path>`) against
 * `repoTopLevel` using pure path segment normalization. Returns `null` when
 * `rawDotGit` is not a `gitdir:` pointer.
 */
export function resolveGitDirPointer(rawDotGit, repoTopLevel) {
  if (typeof rawDotGit !== "string" || typeof repoTopLevel !== "string" || !repoTopLevel) {
    return null;
  }
  const firstLine = rawDotGit.split(/\r?\n/, 1)[0].trim();
  if (!firstLine.startsWith("gitdir:")) return null;
  const target = firstLine.slice("gitdir:".length).trim();
  if (!target || /[\0\r\n]/.test(target)) return null;

  const isWinAbs = /^[A-Za-z]:[\\/]/.test(target);
  const isPosixAbs = target.startsWith("/");
  if (isPosixAbs || isWinAbs) {
    return normalizeSimplePath(target);
  }
  const sep = repoTopLevel.includes("\\") && !repoTopLevel.includes("/") ? "\\" : "/";
  return normalizeSimplePath(`${repoTopLevel.replace(/[\\/]+$/, "")}${sep}${target}`);
}

function normalizeSimplePath(input) {
  const useBackslash = /^[A-Za-z]:\\/.test(input) && !input.includes("/");
  const sep = useBackslash ? "\\" : "/";
  const unified = input.replace(/[\\/]+/g, "/");
  const driveMatch = unified.match(/^([A-Za-z]:)(\/.*)?$/);
  const prefix = driveMatch ? driveMatch[1] : unified.startsWith("/") ? "" : null;
  const rest = driveMatch ? driveMatch[2] || "/" : unified;
  const leadingSlash = prefix !== null;
  const parts = rest.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join(sep);
  if (driveMatch) return `${driveMatch[1]}${sep}${joined}`;
  return leadingSlash ? `${sep}${joined}` : joined || ".";
}

/** Canonical store key for `(repoTopLevel, branch)`. */
export function planStoreKey(repoTopLevel, branch) {
  if (
    typeof repoTopLevel !== "string" ||
    !repoTopLevel.trim() ||
    /[\0\r\n]/.test(repoTopLevel) ||
    typeof branch !== "string" ||
    !parseGitHeadBranch(`ref: refs/heads/${branch}`)
  ) {
    return null;
  }
  return `plan:${repoTopLevel.replace(/[\\/]+$/, "")}\n${branch}`;
}

export function normalizePlanRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isDocumentId(value.documentId)) return null;
  const repoTopLevel = typeof value.repoTopLevel === "string" ? value.repoTopLevel.replace(/[\\/]+$/, "") : "";
  const branch = typeof value.branch === "string" ? value.branch.trim() : "";
  if (!planStoreKey(repoTopLevel, branch)) return null;
  const title = typeof value.title === "string" ? value.title.replace(/[\r\n\t]+/g, " ").trim() : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  return {
    documentId: value.documentId,
    title,
    repoTopLevel,
    branch,
    updatedAt,
  };
}

/** Escapes plan title text so `[!<alt>](...)` cannot break CommonMark link syntax. */
export function escapeMarkdownText(rawTitle) {
  const collapsed = typeof rawTitle === "string" ? rawTitle.replace(/[\r\n\t]+/g, " ").trim() : "";
  const base = (collapsed || "Visual plan").slice(0, 140);
  return base.replace(/[\\[\]`<>]/g, "\\$&");
}

function parseUnpagedHttpsUrl(raw) {
  if (typeof raw !== "string" || !raw.startsWith("https://") || /[\s\\@]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (host !== "unpaged.io" && !host.endsWith(".unpaged.io"))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validates an Unpaged `/join/<token>` link and its `/join/<token>/preview.png`
 * image endpoint on the same HTTPS Unpaged origin.
 */
export function parseJoinLinkUrls({ url, previewUrl } = {}) {
  const joinParsed = parseUnpagedHttpsUrl(url);
  if (!joinParsed || joinParsed.search) return null;
  const match = joinParsed.pathname.match(JOIN_PATH_PATTERN);
  if (!match) return null;
  const token = match[1];
  const cleanUrl = `${joinParsed.origin}/join/${token}`;
  const expectedPreviewPath = `/join/${token}/preview.png`;

  if (previewUrl === undefined || previewUrl === null || previewUrl === "") {
    return { url: cleanUrl, previewUrl: `${joinParsed.origin}${expectedPreviewPath}`, token };
  }
  const previewParsed = parseUnpagedHttpsUrl(previewUrl);
  if (
    !previewParsed ||
    previewParsed.origin !== joinParsed.origin ||
    previewParsed.pathname !== expectedPreviewPath
  ) {
    return null;
  }
  return { url: cleanUrl, previewUrl: `${previewParsed.origin}${expectedPreviewPath}`, token };
}

export function appendPreviewVersion(previewUrl, version) {
  const v = Number(version);
  if (!Number.isSafeInteger(v) || v <= 0) return previewUrl;
  const sep = previewUrl.includes("?") ? "&" : "?";
  return `${previewUrl}${sep}v=${v}`;
}

/**
 * Builds the bounded Markdown section embedded in a GitHub pull request body.
 */
export function renderPrPlanSection({ title, url, previewUrl, version } = {}) {
  const validated = parseJoinLinkUrls({ url, previewUrl });
  if (!validated) {
    throw new Error("invalid_join_link_url");
  }
  const safeTitle = escapeMarkdownText(title);
  const versionedPreview = appendPreviewVersion(validated.previewUrl, version);
  return [
    PR_SECTION_START,
    "### Visual plan",
    "",
    `[![${safeTitle}](${versionedPreview})](${validated.url})`,
    "",
    `[Open visual plan on Unpaged (Can view)](${validated.url})`,
    PR_SECTION_END,
  ].join("\n");
}

/**
 * Replaces an existing `<!-- unpaged-plan:start --> ... <!-- unpaged-plan:end -->`
 * section in place or appends it after existing PR description prose, keeping
 * all surrounding author text untouched.
 */
export function splicePrPlanSection(existingBody, section) {
  if (
    typeof section !== "string" ||
    !section.startsWith(PR_SECTION_START) ||
    !section.endsWith(PR_SECTION_END)
  ) {
    throw new Error("invalid_pr_plan_section");
  }
  const body = typeof existingBody === "string" ? existingBody : "";
  const startIdx = body.indexOf(PR_SECTION_START);
  const endIdx = startIdx >= 0 ? body.indexOf(PR_SECTION_END, startIdx + PR_SECTION_START.length) : -1;
  if (startIdx >= 0 && endIdx >= 0) {
    const before = body.slice(0, startIdx);
    const after = body.slice(endIdx + PR_SECTION_END.length);
    return `${before}${section}${after}`;
  }
  if (!body.trim()) {
    return `${section}\n`;
  }
  const withoutTrailingNewlines = body.replace(/(?:\r?\n)+$/, "");
  return `${withoutTrailingNewlines}\n\n${section}\n`;
}

/**
 * Detects whether a completed tool call just created a GitHub pull request and
 * returns `{ url, number }` when its output carries a pull request URL.
 */
export function extractCreatedPullRequest({ toolName, command = "", resultText = "", isError = false } = {}) {
  if (isError) return null;
  const text = typeof resultText === "string" ? resultText : "";
  if (!text) return null;

  const isShell = isShellToolName(toolName);
  const isMcpPr = !isShell && typeof toolName === "string" && GITHUB_PR_CREATE_TOOL.test(toolName);
  if (!isShell && !isMcpPr) return null;

  if (isShell) {
    const cmd = typeof command === "string" ? command : "";
    if (!PR_CREATE_COMMAND.test(cmd) || DRY_RUN_HEADER.test(text)) {
      return null;
    }
  }

  const match = text.match(PR_URL_PATTERN);
  if (!match) return null;
  return { url: match[0], number: Number(match[1]) };
}

/**
 * Context message returned inside the PR-creation turn when the current branch
 * has a previously built Unpaged visual plan.
 */
export function prPlanAttachContext({ documentId, title, pullRequestUrl } = {}) {
  if (!isDocumentId(documentId) || typeof pullRequestUrl !== "string" || !PR_URL_PATTERN.test(pullRequestUrl)) {
    return "";
  }
  const safeName = title ? `"${String(title).replace(/[\r\n\t"]+/g, " ").trim()}" ` : "";
  return (
    `This branch has an Unpaged visual plan (${safeName}documentId ${documentId}). ` +
    `Attach its Can view invite link and preview to ${pullRequestUrl} now in this turn: ` +
    `1) call document_join_link on the unpaged server with documentId "${documentId}" and role "viewer" ` +
    `(if document_join_link is unavailable on an older server, skip quietly and mention that PR previews need the current Unpaged server); ` +
    `2) read the current PR body (gh pr view "${pullRequestUrl}" --json body --jq .body) and splice ONLY the bounded section ` +
    `${PR_SECTION_START} ... ${PR_SECTION_END} containing "### Visual plan", a blank line, ` +
    `"[![<escaped plan title>](<previewUrl>?v=<unix-seconds>)](<url>)", a blank line, and ` +
    `"[Open visual plan on Unpaged (Can view)](<url>)" — preserving any existing PR description text outside those markers — ` +
    `then update the PR via gh pr edit "${pullRequestUrl}" --body-file <tempfile> using a temporary file outside the repository and delete the temporary file.`
  );
}
