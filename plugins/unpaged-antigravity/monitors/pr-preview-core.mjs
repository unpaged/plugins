// Pure helpers for branch-scoped visual-plan tracking and bounded GitHub PR
// preview sections. No node: imports, no timers, no Buffer: web-standard JS
// only, so the Claude Code mod, the GitHub Copilot extension, and the Node CLI
// scripts share one contract.
import { isDocumentId } from "./listen-core.mjs";

export const PR_SECTION_START = "<!-- unpaged-plan:start -->";
export const PR_SECTION_END = "<!-- unpaged-plan:end -->";
export const BRANCH_PLAN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const AMBIGUOUS_PR_SECTION_MESSAGE =
  "the pull request description has stray or duplicate Unpaged plan marker lines; fix them by hand";

export const PR_CREATE_COMMAND = /(^|[\s;&|(`])gh\s+pr\s+create\b/;
export const DRY_RUN_HEADER = /Would have created a Pull Request with:/;
export const GITHUB_PR_CREATE_TOOL =
  /^(?:mcp__)?[A-Za-z0-9_-]*github[A-Za-z0-9_-]*?(?:__|-)(create_pull_request|open_pull_request|pull_request_create|create_pr)$/i;
export const PR_URL_PATTERN = /https:\/\/[^\s"'<>)\]]+\/pull\/(\d+)/;

const SHELL_TOOLS = new Set(["Bash", "bash", "powershell", "local_shell"]);
const SHARE_PATH_PATTERN = /^\/share\/([^/]+)\/?$/;
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

/**
 * Extracts `remote.origin.url` from a `.git/config` file's text, or `null` when
 * absent.
 */
export function parseOriginRemoteUrl(rawGitConfig) {
  if (typeof rawGitConfig !== "string" || !rawGitConfig) return null;
  let inOrigin = false;
  for (const rawLine of rawGitConfig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1].trim());
      continue;
    }
    if (!inOrigin) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/i);
    if (kv) {
      let val = kv[1].trim();
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1);
      }
      return val || null;
    }
  }
  return null;
}

/**
 * Parses a two-segment remote URL (`https://github.com/owner/repo.git`,
 * `git@github-work:owner/repo.git`, `ssh://git@ssh.github.com:443/owner/repo`,
 * or `gh:owner/repo`) into lowercase `"owner/repo"`, or `null` for local paths,
 * `file://` URLs, or multi-segment group paths.
 */
export function parseGitHubRepoSlug(rawRemoteUrl) {
  if (typeof rawRemoteUrl !== "string") return null;
  const trimmed = rawRemoteUrl.trim();
  if (!trimmed || /^(?:file:\/\/|[A-Za-z]:[\\/])/i.test(trimmed)) return null;
  let match = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/\s:]+(?::\d+)?\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i
  );
  if (!match) {
    match = trimmed.match(/^(?:[^@/\s]+@)?[^/\s:]+:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  }
  if (!match) return null;
  const owner = match[1].toLowerCase();
  const repo = match[2].toLowerCase();
  if (!owner || !repo || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

/**
 * Computes the lowercase `"owner/repo"` of a GitHub PR tool call's head
 * repository (`head` `"forkOwner:branch"` overrides `owner` so fork PRs match
 * the fork clone's `origin`), or `null` when `owner`/`repo` are absent.
 */
export function parseGitHubToolHeadRepoSlug({ owner = "", repo = "", head = "" } = {}) {
  const cleanRepo = typeof repo === "string" ? repo.trim().toLowerCase() : "";
  if (!cleanRepo || /[/?#\s\\]/.test(cleanRepo)) return null;
  const rawHead = typeof head === "string" ? head.trim() : "";
  const colon = rawHead.indexOf(":");
  const rawOwner = colon > 0 ? rawHead.slice(0, colon).trim() : typeof owner === "string" ? owner.trim() : "";
  const cleanOwner = rawOwner.toLowerCase();
  if (!cleanOwner || /[/?#:\s\\]/.test(cleanOwner)) return null;
  return `${cleanOwner}/${cleanRepo}`;
}

export function isDefaultBranchName(branch, originDefaultBranch = null) {
  if (typeof branch !== "string" || !branch) return false;
  if (typeof originDefaultBranch === "string" && originDefaultBranch) {
    return branch === originDefaultBranch;
  }
  return COMMON_DEFAULT_BRANCHES.has(branch);
}

/**
 * Normalizes a GitHub PR tool `head` argument (stripping any `owner:` fork
 * prefix or `refs/heads/` prefix) to a branch name, or `null` when absent/invalid.
 */
export function normalizePullRequestHeadRef(rawHead) {
  if (typeof rawHead !== "string") return null;
  const trimmed = rawHead.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  const candidate = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  const withoutRefs = candidate.startsWith("refs/heads/")
    ? candidate.slice("refs/heads/".length)
    : candidate;
  return parseGitHeadBranch(`ref: refs/heads/${withoutRefs}`);
}

export function isPlanRecordFresh(updatedAt, maxAgeMs = BRANCH_PLAN_MAX_AGE_MS, nowMs = Date.now()) {
  if (typeof updatedAt !== "string" || !updatedAt.trim()) return false;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts) || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return false;
  }
  const ageMs = nowMs - ts;
  return ageMs >= -60_000 && ageMs <= maxAgeMs;
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
 * Validates a plan's public page link, `/share/<documentId>`, and its
 * `/share/<documentId>/preview.png` picture on the same HTTPS Unpaged origin.
 * A team link (`/join/<token>`) is refused: its reader has to sign in, so a
 * pull request reviewer would meet the Log in page.
 */
export function parsePublicLinkUrls({ url, previewUrl } = {}) {
  const pageParsed = parseUnpagedHttpsUrl(url);
  if (!pageParsed || pageParsed.search) return null;
  const match = pageParsed.pathname.match(SHARE_PATH_PATTERN);
  if (!match || !isDocumentId(match[1])) return null;
  const documentId = match[1];
  const cleanUrl = `${pageParsed.origin}/share/${documentId}`;
  const expectedPreviewPath = `/share/${documentId}/preview.png`;

  if (previewUrl === undefined || previewUrl === null || previewUrl === "") {
    return { url: cleanUrl, previewUrl: `${pageParsed.origin}${expectedPreviewPath}`, documentId };
  }
  const previewParsed = parseUnpagedHttpsUrl(previewUrl);
  if (
    !previewParsed ||
    previewParsed.origin !== pageParsed.origin ||
    previewParsed.pathname !== expectedPreviewPath
  ) {
    return null;
  }
  return { url: cleanUrl, previewUrl: `${previewParsed.origin}${expectedPreviewPath}`, documentId };
}

export function describePublicLinkError({ url, previewUrl } = {}) {
  if (!parsePublicLinkUrls({ url })) {
    return "url must be the plan's public Unpaged link, https /share/<documentId>, without query parameters (a /join/<token> team link is not accepted: its reader has to sign in)";
  }
  return "previewUrl must be the matching https /share/<documentId>/preview.png link on the same Unpaged origin";
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
  const validated = parsePublicLinkUrls({ url, previewUrl });
  if (!validated) {
    throw new Error("invalid_public_link_url");
  }
  const safeTitle = escapeMarkdownText(title);
  const versionedPreview = appendPreviewVersion(validated.previewUrl, version);
  return [
    PR_SECTION_START,
    "### Visual plan",
    "",
    `[![${safeTitle}](${versionedPreview})](${validated.url})`,
    "",
    `[Open visual plan on Unpaged (no account needed)](${validated.url})`,
    PR_SECTION_END,
  ].join("\n");
}

function leadingIndentColumns(line) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === " ") cols += 1;
    else if (line[i] === "\t") cols += 4 - (cols % 4);
    else break;
  }
  return cols;
}

function findStandaloneMarkers(body) {
  const starts = [];
  const ends = [];
  let listIndent = 0;
  let fenceChar = null;
  let fenceLen = 0;
  let fenceIndent = "";
  let fenceListIndent = 0;
  let fenceDedented = false;
  let offset = 0;

  while (offset <= body.length) {
    const nl = body.indexOf("\n", offset);
    const lineEnd = nl === -1 ? body.length : nl;
    const contentEnd = lineEnd > offset && body[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = body.slice(offset, contentEnd);
    const trimmed = line.trim();

    if (fenceChar !== null && fenceListIndent > 0 && trimmed !== "" && leadingIndentColumns(line) < fenceListIndent) {
      // CommonMark ends the enclosing list item and closes its fenced code block before this line.
      fenceChar = null;
      fenceLen = 0;
      fenceIndent = "";
      fenceListIndent = 0;
      fenceDedented = false;
      listIndent = 0;
    }

    if (fenceChar !== null) {
      if (trimmed !== "" && leadingIndentColumns(line) < fenceIndent.length) {
        fenceDedented = true;
      }
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
        fenceIndent = "";
        fenceListIndent = 0;
        fenceDedented = false;
      }
    } else {
      const listMatch = line.match(/^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/);
      if (listMatch) {
        listIndent = leadingIndentColumns(listMatch[1].replace(/[^\t]/g, " "));
      } else if (trimmed !== "" && leadingIndentColumns(line) < listIndent) {
        listIndent = 0;
      }

      const openMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
      if (openMatch && !(openMatch[2][0] === "`" && openMatch[3].includes("`"))) {
        fenceIndent = openMatch[1];
        fenceChar = openMatch[2][0];
        fenceLen = openMatch[2].length;
        fenceListIndent = fenceIndent.length >= listIndent ? listIndent : 0;
        fenceDedented = false;
      } else if (trimmed === PR_SECTION_START && leadingIndentColumns(line) <= 3) {
        starts.push({ start: offset, end: contentEnd });
      } else if (trimmed === PR_SECTION_END && leadingIndentColumns(line) <= 3) {
        ends.push({ start: offset, end: contentEnd });
      }
    }

    if (nl === -1) break;
    offset = nl + 1;
  }

  const openFence = fenceChar ? `${fenceIndent}${fenceChar.repeat(fenceLen)}` : "";
  return { starts, ends, openFence, openFenceAmbiguous: fenceChar !== null && fenceDedented };
}

/**
 * Replaces an existing standalone `<!-- unpaged-plan:start --> ... <!-- unpaged-plan:end -->`
 * section in place or appends it after existing PR description prose, keeping
 * all surrounding author text untouched. Ignores markers inside inline code or
 * fenced code blocks, closes a trailing unclosed code fence before appending
 * (or prepends at top level when an indented fence saw a less-indented line),
 * and throws `ambiguous_pr_plan_section` on unpaired or duplicate standalone
 * markers so author text is never overwritten or deleted.
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
  const { starts, ends, openFence, openFenceAmbiguous } = findStandaloneMarkers(body);

  if (starts.length === 0 && ends.length === 0) {
    if (!body.trim()) {
      return `${section}\n`;
    }
    if (openFenceAmbiguous) {
      return `${section}\n\n${body}`;
    }
    const withoutTrailingNewlines = body.replace(/(?:\r?\n)+$/, "");
    const closeFence = openFence ? `\n${openFence}` : "";
    return `${withoutTrailingNewlines}${closeFence}\n\n${section}\n`;
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
export function prPlanAttachContext({
  documentId,
  title,
  pullRequestUrl,
  repoTopLevel = null,
  branch = null,
  originSlug = null,
  spliceScript = "",
} = {}) {
  if (!isDocumentId(documentId) || typeof pullRequestUrl !== "string" || !PR_URL_PATTERN.test(pullRequestUrl)) {
    return "";
  }
  const safeName = title ? `"${String(title).replace(/[\r\n\t"]+/g, " ").trim()}" ` : "";
  const cleanRepo = typeof repoTopLevel === "string" ? repoTopLevel.replace(/[\r\n\0"]+/g, "").trim() : "";
  const validBranch = typeof branch === "string" ? parseGitHeadBranch(`ref: refs/heads/${branch}`) : null;
  const validSlug =
    typeof originSlug === "string" && /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(originSlug.trim())
      ? originSlug.trim()
      : null;
  const cleanScript = typeof spliceScript === "string" ? spliceScript.replace(/[\r\n\0"]+/g, "").trim() : "";
  const scriptPath = cleanScript || "${CLAUDE_PLUGIN_ROOT}/monitors/plans.mjs";
  const checkoutLabel = cleanRepo ? `checkout "${cleanRepo}"` : "this checkout";
  const scrubbedRemoteCmd = cleanRepo
    ? `git -C "${cleanRepo}" remote get-url origin | sed -E 's#://[^/@]*@#://#'`
    : `git remote get-url origin | sed -E 's#://[^/@]*@#://#'`;
  let repoAndBranchCheck;
  if (validSlug && validBranch) {
    repoAndBranchCheck =
      `First verify ${pullRequestUrl} was opened from ${checkoutLabel} (${validSlug} on branch "${validBranch}"): ` +
      `run gh pr view "${pullRequestUrl}" --json headRepositoryOwner,headRepository,headRefName --jq '(.headRepositoryOwner.login + "/" + .headRepository.name | ascii_downcase) + ":" + .headRefName' — ` +
      `attach nothing and leave the PR description unchanged unless it prints "${validSlug}:${validBranch}". `;
  } else if (validSlug) {
    repoAndBranchCheck =
      `First verify ${pullRequestUrl} was opened from ${checkoutLabel} (${validSlug}): ` +
      `run gh pr view "${pullRequestUrl}" --json headRepositoryOwner,headRepository --jq '.headRepositoryOwner.login + "/" + .headRepository.name | ascii_downcase' — ` +
      `attach nothing and leave the PR description unchanged unless it prints "${validSlug}". `;
  } else if (validBranch) {
    repoAndBranchCheck =
      `First verify ${pullRequestUrl} was opened from ${checkoutLabel} on branch "${validBranch}": ` +
      `take lowercase <owner>/<name> from ${scrubbedRemoteCmd} and run gh pr view "${pullRequestUrl}" --json headRepositoryOwner,headRepository,headRefName --jq '(.headRepositoryOwner.login + "/" + .headRepository.name | ascii_downcase) + ":" + .headRefName' — ` +
      `attach nothing and leave the PR description unchanged unless it prints "<owner>/<name>:${validBranch}". `;
  } else {
    repoAndBranchCheck =
      `First verify ${pullRequestUrl} was opened from ${checkoutLabel}: ` +
      `take lowercase <owner>/<name> from ${scrubbedRemoteCmd} and run gh pr view "${pullRequestUrl}" --json headRepositoryOwner,headRepository --jq '.headRepositoryOwner.login + "/" + .headRepository.name | ascii_downcase' — ` +
      `attach nothing and leave the PR description unchanged unless it prints "<owner>/<name>". `;
  }
  return (
    `Visual plan candidate for ${checkoutLabel} (${safeName}documentId ${documentId}). ` +
    `Skip this plan and leave the PR description unchanged if this session has already attached it to another pull request. ` +
    repoAndBranchCheck +
    `Attach this plan to ${pullRequestUrl} now in this turn only if it is about this pull request's work ` +
    `(compare the plan's title — or read the canvas with document_get when the title isn't enough — against the pull request's title and changes; otherwise skip it, leave the PR description unchanged, and say in one sentence why): ` +
    `1) call document_update on the unpaged server with documentId "${documentId}" and isPublic: true — this makes the plan public (anyone with its link can read it without an account, and copy it once signed in) and redraws its link-preview picture; ` +
    `if the call is refused (for example, only the plan's owner can make it public), attach nothing, leave the PR description unchanged, and say why in one sentence; ` +
    `the plan's public link <url> is the one the reply gives, or, when the reply gives none, <web app>/share/${documentId} where <web app> is the web app address the unpaged server's instructions name (https://unpaged.io for mcp.unpaged.io); ` +
    `2) never pass a canvas title on a shell command line — when node is on PATH, write temporary files outside the repository and run ` +
    `gh pr view "${pullRequestUrl}" --json body --jq .body > "<inFile>" && node "${scriptPath}" splice "<url>" < "<inFile>" > "<outFile>" && gh pr edit "${pullRequestUrl}" --body-file "<outFile>", ` +
    `then delete "<inFile>" and "<outFile>" (if splice exits non-zero, leave the PR description unchanged, delete the temporary files, and report in one sentence the reason splice printed on stderr — never hand-splice after splice refused); ` +
    `only when node is not on PATH, read the current PR body with gh pr view "${pullRequestUrl}" --json body --jq .body, splice ONLY a single standalone bounded section ${PR_SECTION_START} ... ${PR_SECTION_END} containing "### Visual plan", a blank line, ` +
    `"[![Visual plan](<url>/preview.png?v=<unix-seconds>)](<url>)", a blank line, and "[Open visual plan on Unpaged (no account needed)](<url>)" into "<outFile>" outside the repository (preserving all surrounding PR description text, or leaving the description unchanged if existing marker lines are unpaired or duplicated), ` +
    `run gh pr edit "${pullRequestUrl}" --body-file "<outFile>", and delete "<outFile>"; ` +
    `3) whenever the document_update call succeeded, even if the splice or gh pr edit then failed and nothing was attached, tell the person in one sentence that the plan is now public — anyone with the link can read it without an account — and that Share → Public link in Unpaged turns that off.`
  );
}
