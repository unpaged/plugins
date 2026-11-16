#!/usr/bin/env node
// Host-side branch-plan storage and bounded GitHub PR section splicing for
// Unpaged for Codex. Produces the exact same bounded Markdown section as the
// Claude Code, GitHub Copilot, and Antigravity plugins.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { UUID } from "./protocol.mjs";

export const PR_SECTION_START = "<!-- unpaged-plan:start -->";
export const PR_SECTION_END = "<!-- unpaged-plan:end -->";
export const PENDING_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const JOIN_PATH_PATTERN = /^\/join\/([A-Za-z0-9_-]{16,128})\/?$/;
const COMMON_DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);

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

export function resolveCommonGitDir(rawCommonDir, gitDir) {
  if (typeof gitDir !== "string" || !gitDir) return null;
  if (typeof rawCommonDir !== "string" || !rawCommonDir.trim()) return gitDir;
  const target = rawCommonDir.split(/\r?\n/, 1)[0].trim();
  if (!target || /[\0\r\n]/.test(target)) return gitDir;
  return resolve(gitDir, target);
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

export function pendingPlanStoreKey(repoTopLevel) {
  if (typeof repoTopLevel !== "string" || !repoTopLevel.trim() || /[\0\r\n]/.test(repoTopLevel)) {
    return null;
  }
  return `pending:${repoTopLevel.replace(/[\\/]+$/, "")}`;
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
      } else if (trimmed === PR_SECTION_START) {
        starts.push({ start: offset, end: contentEnd });
      } else if (trimmed === PR_SECTION_END) {
        ends.push({ start: offset, end: contentEnd });
      }
    }

    if (nl === -1) break;
    offset = nl + 1;
  }

  const openFence = fenceChar ? `${fenceIndent}${fenceChar.repeat(fenceLen)}` : "";
  return { starts, ends, openFence, openFenceAmbiguous: fenceChar !== null && fenceDedented };
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
  const { starts, ends, openFence, openFenceAmbiguous } = findStandaloneMarkers(body);

  if (starts.length === 0 && ends.length === 0) {
    if (!body.trim()) return `${section}\n`;
    if (openFenceAmbiguous) return `${section}\n\n${body}`;
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

async function readOriginDefaultBranch(gitDir) {
  const candidates = [join(gitDir, "refs", "remotes", "origin", "HEAD")];
  try {
    const commonRaw = await readFile(join(gitDir, "commondir"), "utf8");
    const commonDir = resolveCommonGitDir(commonRaw, gitDir);
    if (commonDir && commonDir !== gitDir) {
      candidates.push(join(commonDir, "refs", "remotes", "origin", "HEAD"));
    }
  } catch {
    // Normal .git directory has no commondir file.
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseOriginHeadBranch(await readFile(candidate, "utf8"));
      if (parsed) return parsed;
    } catch {
      // Try next candidate.
    }
  }
  return null;
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
      if (!branch) return null;
      const defaultBranch = await readOriginDefaultBranch(gitDir);
      return {
        repoTopLevel: folder,
        branch,
        isDefaultBranch: isDefaultBranchName(branch, defaultBranch),
      };
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

function pendingPlanFileFor(dataDir, repoTopLevel) {
  const key = pendingPlanStoreKey(repoTopLevel);
  if (!key) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return join(dataDir, "plans", `${hash}.json`);
}

async function writeAtomicPlanFile(dataDir, file, value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, "plans"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function recordBranchPlan({ dataDir, cwd, documentId, title = "" }) {
  if (!UUID.test(documentId || "")) throw new Error("invalid_document_id");
  const branchCtx = await resolveRepositoryBranch(cwd);
  if (!branchCtx) return { recorded: false };
  const cleanTitle = typeof title === "string" ? title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) : "";
  const updatedAt = new Date().toISOString();

  if (branchCtx.isDefaultBranch) {
    const pendingFile = pendingPlanFileFor(dataDir, branchCtx.repoTopLevel);
    if (!pendingFile) return { recorded: false };
    await writeAtomicPlanFile(dataDir, pendingFile, {
      documentId,
      title: cleanTitle,
      repoTopLevel: branchCtx.repoTopLevel,
      updatedAt,
    });
    return { recorded: true, documentId, title: cleanTitle, branch: branchCtx.branch };
  }

  const file = planFileFor(dataDir, branchCtx.repoTopLevel, branchCtx.branch);
  if (!file) return { recorded: false };
  const record = {
    documentId,
    title: cleanTitle,
    repoTopLevel: branchCtx.repoTopLevel,
    branch: branchCtx.branch,
    updatedAt,
  };
  await writeAtomicPlanFile(dataDir, file, record);
  const pendingFile = pendingPlanFileFor(dataDir, branchCtx.repoTopLevel);
  if (pendingFile) await rm(pendingFile, { force: true }).catch(() => {});
  return { recorded: true, documentId, title: cleanTitle, branch: branchCtx.branch };
}

async function promotePendingBranchPlan(dataDir, branchCtx) {
  const pendingFile = pendingPlanFileFor(dataDir, branchCtx.repoTopLevel);
  const targetFile = planFileFor(dataDir, branchCtx.repoTopLevel, branchCtx.branch);
  if (!pendingFile || !targetFile) return null;
  try {
    const parsed = JSON.parse(await readFile(pendingFile, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !UUID.test(parsed.documentId || "") ||
      parsed.repoTopLevel !== branchCtx.repoTopLevel
    ) {
      return null;
    }
    const ageMs = Date.now() - Date.parse(String(parsed.updatedAt || ""));
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PENDING_PLAN_MAX_AGE_MS) {
      await rm(pendingFile, { force: true }).catch(() => {});
      return null;
    }
    const cleanTitle = typeof parsed.title === "string" ? parsed.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) : "";
    const updatedAt = new Date().toISOString();
    const record = {
      documentId: parsed.documentId,
      title: cleanTitle,
      repoTopLevel: branchCtx.repoTopLevel,
      branch: branchCtx.branch,
      updatedAt,
    };
    await writeAtomicPlanFile(dataDir, targetFile, record);
    await rm(pendingFile, { force: true }).catch(() => {});
    return {
      recorded: true,
      documentId: record.documentId,
      title: cleanTitle,
      branch: record.branch,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export async function lookupBranchPlan({ dataDir, cwd }) {
  const branchCtx = await resolveRepositoryBranch(cwd);
  if (!branchCtx || branchCtx.isDefaultBranch) return { recorded: false };
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
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return (await promotePendingBranchPlan(dataDir, branchCtx)) ?? { recorded: false };
    }
    return { recorded: false };
  }
}

export function buildSplicedPrBody({ url, previewUrl, title = "", body, bodyLength, version } = {}) {
  if (typeof body !== "string") throw new Error("invalid_pr_body");
  if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) throw new Error("invalid_pr_body_length");
  if ([...body].length !== bodyLength) throw new Error("truncated_pr_body");
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

function readStdinText() {
  return new Promise((resolvePromise) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolvePromise(text));
    process.stdin.on("error", () => resolvePromise(text));
  });
}

async function spliceCli(url, previewUrl) {
  const validated = parseJoinLinkUrls({ url, previewUrl });
  if (!validated) {
    process.stderr.write("pr-preview.mjs splice: url must be an Unpaged https /join/<token> link\n");
    return 1;
  }
  if (process.stdin.isTTY) {
    process.stderr.write("pr-preview.mjs splice: expected existing PR body on stdin (stdin is a TTY)\n");
    return 1;
  }
  const existingBody = await readStdinText();
  if (existingBody.length === 0) {
    process.stderr.write(
      "pr-preview.mjs splice: expected existing PR body on stdin (0 bytes received; check that gh pr view succeeded)\n"
    );
    return 1;
  }
  const envVersion = process.env.UNPAGED_PREVIEW_VERSION ? Number(process.env.UNPAGED_PREVIEW_VERSION) : 0;
  const version = Number.isSafeInteger(envVersion) && envVersion > 0 ? envVersion : Math.floor(Date.now() / 1000);
  try {
    const section = renderPrPlanSection({
      title: "",
      url: validated.url,
      previewUrl: validated.previewUrl,
      version,
    });
    process.stdout.write(splicePrPlanSection(existingBody, section));
    return 0;
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    process.stderr.write(`pr-preview.mjs splice: ${reason}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("pr-preview.mjs")) {
  const [verb, first, second] = process.argv.slice(2);
  const runCli = verb === "splice" ? spliceCli(first, second) : Promise.resolve((process.stderr.write("usage: pr-preview.mjs splice <url> [previewUrl]\n"), 1));
  runCli
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`pr-preview.mjs: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
