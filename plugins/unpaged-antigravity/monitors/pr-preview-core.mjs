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
const COMMON_DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);

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
    branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) ||
    /[\0-\x1f\x7f ~^:?*[\\]/.test(branch)
  ) {
    return null;
  }
  return branch;
}

/**
 * Parses `.git/refs/remotes/origin/HEAD` (`ref: refs/remotes/origin/<branch>`)
 * and returns the remote default branch name, or `null` when absent/unrecognized.
 */
export function parseOriginHeadBranch(rawOriginHead) {
  if (typeof rawOriginHead !== "string") return null;
  const match = rawOriginHead.trim().match(/^ref:\s*refs\/remotes\/[^/\s]+\/(.+)$/);
  if (!match) return null;
  return parseGitHeadBranch(`ref: refs/heads/${match[1]}`);
}

export function isDefaultBranchName(branch, originDefaultBranch = null) {
  if (typeof branch !== "string" || !branch) return false;
  if (typeof originDefaultBranch === "string" && originDefaultBranch) {
    return branch === originDefaultBranch;
  }
  return COMMON_DEFAULT_BRANCHES.has(branch);
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
  return resolveRelativePath(repoTopLevel, target);
}

/**
 * Resolves a worktree's `commondir` file text against `gitDir` using pure path
 * segment normalization.
 */
export function resolveCommonGitDir(rawCommonDir, gitDir) {
  if (typeof gitDir !== "string" || !gitDir) return null;
  if (typeof rawCommonDir !== "string" || !rawCommonDir.trim()) return gitDir;
  const target = rawCommonDir.split(/\r?\n/, 1)[0].trim();
  if (!target || /[\0\r\n]/.test(target)) return gitDir;
  return resolveRelativePath(gitDir, target);
}

function resolveRelativePath(baseDir, target) {
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(target);
  const isPosixAbs = target.startsWith("/");
  if (isPosixAbs || isWinAbs) {
    return normalizeSimplePath(target);
  }
  const sep = baseDir.includes("\\") && !baseDir.includes("/") ? "\\" : "/";
  return normalizeSimplePath(`${baseDir.replace(/[\\/]+$/, "")}${sep}${target}`);
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

export function pendingPlanStoreKey(repoTopLevel) {
  if (typeof repoTopLevel !== "string" || !repoTopLevel.trim() || /[\0\r\n]/.test(repoTopLevel)) {
    return null;
  }
  return `pending:${repoTopLevel.replace(/[\\/]+$/, "")}`;
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

function findStandaloneMarkers(body) {
  const starts = [];
  const ends = [];
  let fenceChar = null;
  let fenceLen = 0;
  let offset = 0;

  while (offset <= body.length) {
    const nl = body.indexOf("\n", offset);
    const lineEnd = nl === -1 ? body.length : nl;
    const contentEnd = lineEnd > offset && body[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = body.slice(offset, contentEnd);

    if (fenceChar !== null) {
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    } else {
      const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch && !(openMatch[1][0] === "`" && openMatch[2].includes("`"))) {
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
      } else {
        const trimmed = line.trim();
        if (trimmed === PR_SECTION_START) {
          starts.push({ start: offset, end: contentEnd });
        } else if (trimmed === PR_SECTION_END) {
          ends.push({ start: offset, end: contentEnd });
        }
      }
    }

    if (nl === -1) break;
    offset = nl + 1;
  }

  return { starts, ends };
}

/**
 * Replaces an existing standalone `<!-- unpaged-plan:start --> ... <!-- unpaged-plan:end -->`
 * section in place or appends it after existing PR description prose, keeping
 * all surrounding author text untouched. Ignores markers inside inline code or
 * fenced code blocks, and throws `ambiguous_pr_plan_section` on unpaired or
 * duplicate standalone markers so author text is never overwritten or deleted.
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
  const { starts, ends } = findStandaloneMarkers(body);

  if (starts.length === 0 && ends.length === 0) {
    if (!body.trim()) {
      return `${section}\n`;
    }
    const withoutTrailingNewlines = body.replace(/(?:\r?\n)+$/, "");
    return `${withoutTrailingNewlines}\n\n${section}\n`;
  }

  if (starts.length === 1 && ends.length === 1 && starts[0].start < ends[0].start) {
    const before = body.slice(0, starts[0].start);
    const after = body.slice(ends[0].end);
    return `${before}${section}${after}`;
  }

  throw new Error("ambiguous_pr_plan_section");
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
 * (or current session) has a previously built Unpaged visual plan. Never asks
 * the agent to interpolate a canvas title onto a shell command line.
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
    `2) read the current PR body into a temporary file outside the repository (gh pr view "${pullRequestUrl}" --json body --jq .body > "<inFile>"), ` +
    `splice ONLY the standalone bounded section ${PR_SECTION_START} ... ${PR_SECTION_END} containing "### Visual plan", a blank line, ` +
    `"[![Visual plan](<previewUrl>?v=<unix-seconds>)](<url>)", a blank line, and "[Open visual plan on Unpaged (Can view)](<url>)" ` +
    `into a second temporary file "<outFile>" (preserving any existing PR description text outside those standalone marker lines; never pass a canvas title on a shell command line), ` +
    `run gh pr edit "${pullRequestUrl}" --body-file "<outFile>", and delete both temporary files.`
  );
}
