// Pure helpers for branch-scoped visual-plan tracking and bounded GitHub PR
// preview sections. No node: imports, no timers, no Buffer: web-standard JS
// only, matching plugins/unpaged/monitors/pr-preview-core.mjs byte-for-byte.
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
