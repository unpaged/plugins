// Host-side branch-plan storage and bounded GitHub PR section splicing for
// Unpaged for Codex. Produces the exact same bounded Markdown section as the
// Claude Code, GitHub Copilot, and Antigravity plugins.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { UUID } from "./protocol.mjs";

export const PR_SECTION_START = "<!-- unpaged-plan:start -->";
export const PR_SECTION_END = "<!-- unpaged-plan:end -->";

const JOIN_PATH_PATTERN = /^\/join\/([A-Za-z0-9_-]{16,128})\/?$/;

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
  return resolve(repoTopLevel, target);
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
  if (!validated) throw new Error("invalid_join_link_url");
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
  if (!body.trim()) return `${section}\n`;
  const withoutTrailingNewlines = body.replace(/(?:\r?\n)+$/, "");
  return `${withoutTrailingNewlines}\n\n${section}\n`;
}

export async function resolveRepositoryBranch(startDir) {
  if (typeof startDir !== "string" || !startDir) return null;
  let folder = resolve(startDir);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(folder, ".git");
    try {
      const info = await stat(dotGit);
      let gitDir = null;
      if (info.isDirectory()) {
        gitDir = dotGit;
      } else if (info.isFile()) {
        gitDir = resolveGitDirPointer(await readFile(dotGit, "utf8"), folder);
      }
      if (!gitDir) return null;
      const headRaw = await readFile(join(gitDir, "HEAD"), "utf8");
      const branch = parseGitHeadBranch(headRaw);
      return branch ? { repoTopLevel: folder, branch } : null;
    } catch {
      // Walk upward.
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

function planFileFor(dataDir, repoTopLevel, branch) {
  const key = planStoreKey(repoTopLevel, branch);
  if (!key) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return join(dataDir, "plans", `${hash}.json`);
}

export async function recordBranchPlan({ dataDir, cwd, documentId, title = "" }) {
  if (!UUID.test(documentId || "")) throw new Error("invalid_document_id");
  const branchCtx = await resolveRepositoryBranch(cwd);
  if (!branchCtx) return { recorded: false };
  const file = planFileFor(dataDir, branchCtx.repoTopLevel, branchCtx.branch);
  if (!file) return { recorded: false };
  const cleanTitle = typeof title === "string" ? title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) : "";
  const record = {
    documentId,
    title: cleanTitle,
    repoTopLevel: branchCtx.repoTopLevel,
    branch: branchCtx.branch,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, "plans"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return { recorded: true, documentId, title: cleanTitle, branch: branchCtx.branch };
}

export async function lookupBranchPlan({ dataDir, cwd }) {
  const branchCtx = await resolveRepositoryBranch(cwd);
  if (!branchCtx) return { recorded: false };
  const file = planFileFor(dataDir, branchCtx.repoTopLevel, branchCtx.branch);
  if (!file) return { recorded: false };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !UUID.test(parsed.documentId || "") ||
      parsed.repoTopLevel !== branchCtx.repoTopLevel ||
      parsed.branch !== branchCtx.branch
    ) {
      return { recorded: false };
    }
    const cleanTitle = typeof parsed.title === "string" ? parsed.title.replace(/[\r\n\t]+/g, " ").trim() : "";
    return {
      recorded: true,
      documentId: parsed.documentId,
      title: cleanTitle,
      branch: parsed.branch,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return { recorded: false };
  }
}

export function buildSplicedPrBody({ url, previewUrl, title = "", body = "", version } = {}) {
  const validated = parseJoinLinkUrls({ url, previewUrl });
  if (!validated) throw new Error("invalid_join_link_url");
  const resolvedVersion =
    Number.isSafeInteger(version) && version > 0 ? version : Math.floor(Date.now() / 1000);
  const section = renderPrPlanSection({
    title,
    url: validated.url,
    previewUrl: validated.previewUrl,
    version: resolvedVersion,
  });
  return {
    url: validated.url,
    previewUrl: validated.previewUrl,
    section,
    body: splicePrPlanSection(body, section),
  };
}
