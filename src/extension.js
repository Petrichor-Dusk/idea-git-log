const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_COMMITS = 500;

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git ${args.join(" ")} 失败：${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseBranches(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [fullName, shortName, objectName, peeledObject, upstream] = line.split("\0");
      const isRemote = fullName.startsWith("refs/remotes/");
      const isTag = fullName.startsWith("refs/tags/");
      const remoteParts = isRemote ? shortName.split("/") : [];
      const remoteBranchName = remoteParts.slice(1).join("/");
      return {
        fullName,
        name: isRemote ? remoteBranchName : shortName,
        remote: isRemote ? remoteParts[0] : "",
        commit: peeledObject || objectName,
        upstream,
        ahead: 0,
        behind: 0,
        kind: isRemote ? "remote" : isTag ? "tag" : "local",
        symbolicHead: isRemote && remoteBranchName === "HEAD",
      };
    })
    .filter((branch) => branch.name && !branch.symbolicHead);
}

function parseCommits(output) {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, author, date, subject] = record.split("\0");
      return {
        hash,
        parents: parents ? parents.split(" ") : [],
        author,
        date,
        subject,
      };
    })
    .filter((commit) => /^[0-9a-f]{40,64}$/i.test(commit.hash));
}

async function getRepository(folder) {
  return (await runGit(folder, ["rev-parse", "--show-toplevel"])).trim();
}

async function getBranches(root) {
  const [branchOutput, headOutput] = await Promise.all([
    runGit(root, [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(upstream)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
  ]);
  const branches = parseBranches(branchOutput);
  const refs = new Set(branches.map((branch) => branch.fullName));
  const trackedBranches = await Promise.all(
    branches.map(async (branch) => {
      if (branch.kind !== "local" || !branch.upstream) return branch;
      if (!refs.has(branch.upstream)) return { ...branch, upstreamGone: true };
      const counts = await runGit(root, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch.fullName}...${branch.upstream}`,
      ]);
      const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
      return { ...branch, ahead, behind };
    }),
  );
  return {
    branches: trackedBranches,
    currentBranch: headOutput.trim(),
  };
}

async function getCommits(root, selectedRef, skip) {
  const args = [
    "log",
    "--max-count=" + MAX_COMMITS,
    "--skip=" + skip,
    "--date=iso-strict",
    "--format=%H%x00%P%x00%an%x00%aI%x00%s%x1e",
    "--grep=^Agent host session",
    "--invert-grep",
  ];
  if (selectedRef) {
    args.push(selectedRef);
  } else {
    args.push("HEAD");
  }
  return parseCommits(await runGit(root, args));
}

async function getCommitDetails(root, hash) {
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) {
    throw new Error("无效的提交 ID");
  }
  const metadata = await runGit(root, [
    "show",
    "-s",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b",
    hash,
  ]);
  const [fullHash, parents, author, email, date, subject, body] = metadata.split("\0");
  const parentHashes = parents ? parents.split(" ") : [];
  const diffArgs = [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    "--no-renames",
  ];
  if (parentHashes.length) {
    diffArgs.push(parentHashes[0], fullHash);
  } else {
    diffArgs.push("--root", fullHash);
  }
  const fileOutput = await runGit(root, diffArgs);
  const tokens = fileOutput.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    files.push({ status: tokens[i], path: tokens[i + 1] });
  }
  return {
    hash: fullHash,
    parents: parentHashes,
    author,
    email,
    date,
    subject,
    body: (body || "").trim(),
    files,
  };
}

function createRevisionUri(root, revision, filePath, empty = false) {
  const query = Buffer.from(
    JSON.stringify({ root, revision, filePath, empty }),
  ).toString("base64url");
  return vscode.Uri.from({
    scheme: "idea-git-log",
    authority: "revision",
    path: `/${revision || "empty"}/${path.basename(filePath)}`,
    query,
  });
}

async function openCommitFileDiff(root, hash, filePath) {
  const detail = await getCommitDetails(root, hash);
  const file = detail.files.find((entry) => entry.path === filePath);
  if (!file) throw new Error("该文件不属于所选提交");

  const parent = detail.parents[0] || "";
  const before = createRevisionUri(
    root,
    parent,
    file.path,
    !parent || file.status === "A",
  );
  const after = createRevisionUri(
    root,
    detail.hash,
    file.path,
    file.status === "D",
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    after,
    `${file.path} (${detail.hash.slice(0, 8)})`,
    { preview: true },
  );
}

function readVscodeIconsTheme(extension) {
  const contribution = extension.packageJSON.contributes?.iconThemes?.find(
    (theme) => theme.id === "vscode-icons",
  );
  if (!contribution) {
    throw new Error("vscode-icons 扩展没有提供 vscode-icons 图标主题");
  }
  const manifestPath = path.resolve(extension.extensionPath, contribution.path);
  const theme = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { extensionPath: extension.extensionPath, manifestPath, theme };
}

function createIconResolver(webview, iconTheme, isLight) {
  const { extensionPath, manifestPath, theme } = iconTheme;
  const appearance = isLight && theme.light ? theme.light : {};
  const definitions = { ...theme.iconDefinitions, ...theme.light?.iconDefinitions };
  const fileNameMaps = [appearance.fileNames, theme.fileNames]
    .filter(Boolean)
    .map((mapping) => new Map(Object.entries(mapping).map(([name, id]) => [name.toLowerCase(), id])));
  const fileExtensionMaps = [appearance.fileExtensions, theme.fileExtensions]
    .filter(Boolean)
    .map((mapping) => new Map(Object.entries(mapping).map(([name, id]) => [name.toLowerCase(), id])));
  const languageMaps = [appearance.languageIds, theme.languageIds]
    .filter(Boolean)
    .map((mapping) => new Map(Object.entries(mapping).map(([name, id]) => [name.toLowerCase(), id])));
  const folderMaps = [appearance.folderNames, theme.folderNames]
    .filter(Boolean)
    .map((mapping) => new Map(Object.entries(mapping).map(([name, id]) => [name.toLowerCase(), id])));
  const expandedFolderMaps = [appearance.folderNamesExpanded, theme.folderNamesExpanded]
    .filter(Boolean)
    .map((mapping) => new Map(Object.entries(mapping).map(([name, id]) => [name.toLowerCase(), id])));
  const extensions = [...new Set([
    ...Object.keys(theme.fileExtensions || {}),
    ...Object.keys(appearance.fileExtensions || {}),
  ])].sort((a, b) => b.length - a.length);
  const uriCache = new Map();
  const languageByExtension = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    dart: "dart",
    go: "go",
    h: "c",
    htm: "html",
    html: "html",
    java: "java",
    js: "javascript",
    jsx: "javascriptreact",
    json: "json",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "shellscript",
    sql: "sql",
    ts: "typescript",
    tsx: "typescriptreact",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };

  const findId = (maps, key) => {
    const normalized = key.toLowerCase();
    for (const mapping of maps) {
      const iconId = mapping.get(normalized);
      if (iconId) return iconId;
    }
    return undefined;
  };
  const iconUri = (iconId) => {
    if (uriCache.has(iconId)) return uriCache.get(iconId);
    const definition = definitions[iconId];
    if (!definition) throw new Error(`vscode-icons 图标主题缺少定义：${iconId}`);
    if (!definition.iconPath) return "";
    const assetPath = path.resolve(path.dirname(manifestPath), definition.iconPath);
    const relativePath = path.relative(extensionPath, assetPath);
    if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
      throw new Error(`vscode-icons 图标路径超出扩展目录：${definition.iconPath}`);
    }
    if (!fs.existsSync(assetPath)) {
      throw new Error(`vscode-icons 图标文件不存在：${definition.iconPath}`);
    }
    const uri = webview.asWebviewUri(vscode.Uri.file(assetPath)).toString();
    uriCache.set(iconId, uri);
    return uri;
  };
  const iconForFile = (filePath) => {
    const fileName = path.posix.basename(filePath);
    let iconId = findId(fileNameMaps, fileName);
    const normalizedName = fileName.toLowerCase();
    if (!iconId) {
      for (const extension of extensions) {
        if (!normalizedName.endsWith(`.${extension.toLowerCase()}`)) continue;
        iconId = findId(fileExtensionMaps, extension);
        if (iconId) break;
      }
    }
    if (!iconId) {
      const extension = path.posix.extname(fileName).slice(1).toLowerCase();
      const language = languageByExtension[extension];
      if (language) iconId = findId(languageMaps, language);
    }
    return iconUri(iconId || appearance.file || theme.file);
  };
  const iconForFolder = (segments, expanded, isRoot = false) => {
    let iconId;
    if (isRoot) {
      iconId = expanded
        ? appearance.rootFolderExpanded || theme.rootFolderExpanded
        : appearance.rootFolder || theme.rootFolder;
    } else {
      const maps = expanded
        ? [...expandedFolderMaps, ...folderMaps]
        : folderMaps;
      for (const segment of segments.slice().reverse()) {
        iconId = findId(maps, segment);
        if (iconId) break;
      }
      if (!iconId) {
        iconId = expanded
          ? appearance.folderExpanded || theme.folderExpanded
          : appearance.folder || theme.folder;
      }
    }
    return iconUri(iconId || appearance.folder || theme.folder);
  };
  return { iconForFile, iconForFolder };
}

function getWebviewHtml(webview, codiconsCssUri) {
  const nonce = randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconsCssUri}">
  <title>Git Log</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border, var(--vscode-editorWidget-border));
      --muted: var(--vscode-descriptionForeground);
      --hover: var(--vscode-list-hoverBackground);
      --active: var(--vscode-list-activeSelectionBackground);
      --focus: var(--vscode-focusBorder);
      --surface: var(--vscode-sideBar-background);
      --graph-width: 48px;
      --branch-width: 220px;
      --details-width: 340px;
      --splitter-width: 6px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    body { height: 100vh; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    button, input { color: inherit; font: inherit; }
    button { border: 0; background: transparent; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
    .layout { display: grid; grid-template-columns: minmax(150px, var(--branch-width)) var(--splitter-width) minmax(420px, 1fr) var(--splitter-width) minmax(240px, var(--details-width)); height: 100%; min-height: 0; min-width: 760px; overflow: hidden; }
    .branches, .details { min-width: 0; min-height: 0; overflow-x: hidden; background: var(--surface); }
    .branches { overflow-y: auto; overscroll-behavior: contain; }
    .branch-pane-header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; height: 38px; background: var(--surface); }
    .branch-pane-header > .pane-title { height: auto; flex: 1; }
    .branch-refresh { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; margin-right: 6px; padding: 0; border-radius: 3px; color: var(--muted); }
    .branch-refresh:hover { background: var(--hover); color: var(--vscode-foreground); }
    .pane-splitter { position: relative; z-index: 3; min-width: 0; cursor: col-resize; touch-action: none; user-select: none; }
    .pane-splitter::after { position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: var(--border); content: ""; transform: translateX(-50%); }
    .pane-splitter:hover, .pane-splitter.dragging { background: var(--hover); }
    .pane-splitter:hover::after, .pane-splitter.dragging::after { width: 2px; background: var(--focus); }
    .pane-splitter:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
    body.resizing { cursor: col-resize; user-select: none; }
    .details { display: flex; flex-direction: column; overflow: hidden; }
    .main { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .pane-title { height: 38px; flex: 0 0 38px; padding: 11px 12px 8px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .detail-content { min-width: 0; min-height: 0; display: flex; flex: 1; flex-direction: column; overflow: hidden; }
    .detail-content.empty { display: block; }
    .section-title { padding: 10px 12px 5px; color: var(--muted); font-size: 11px; font-weight: 700; }
    .branch-search { display: flex; align-items: center; gap: 7px; margin: 0 8px 8px; padding: 0 7px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; background: var(--vscode-input-background); color: var(--muted); }
    .branch-search input { width: 100%; min-width: 0; height: 28px; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground); }
    .branch-search input::placeholder { color: var(--muted); }
    .section-row { width: 100%; display: flex; align-items: center; gap: 6px; padding: 7px 10px 4px; color: var(--muted); text-align: left; }
    .section-row:hover { background: var(--hover); }
    .section-chevron { width: 14px; flex: 0 0 14px; display: flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; }
    .section-count { margin-left: auto; font-size: 10px; }
    .remote-folder { padding-left: 20px; }
    .remote-folder .section-chevron { color: var(--vscode-foreground); }
    .branch-row { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 7px; padding: 4px 10px; text-align: left; }
    .branch-row:hover, .toolbar button:hover, .file:hover { background: var(--hover); }
    .branch-row.selected { background: var(--active); }
    .branch-context-menu { position: fixed; z-index: 20; min-width: 172px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--border)); border-radius: 4px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 4px 14px #0004; }
    .branch-context-menu button { width: 100%; display: block; padding: 7px 10px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .branch-context-menu button:hover, .branch-context-menu button:focus-visible { outline: 0; background: var(--vscode-menu-selectionBackground, var(--hover)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
    .branch-label { overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
    .branch-type, .branch-remote, .muted { color: var(--muted); }
    .branch-type { width: 16px; flex: 0 0 16px; text-align: center; }
    .branch-type.current { color: var(--vscode-charts-yellow, #e5c07b); }
    .branch-type.tag { color: var(--vscode-charts-yellow, #e5c07b); }
    .branch-row.remote { padding-left: 21px; }
    .tracking-count { flex: 0 0 auto; font-size: 11px; }
    .tracking-count.behind { color: var(--vscode-charts-blue, #4fc1ff); }
    .tracking-count.ahead { color: var(--vscode-charts-green, #98c379); }
    .tracking-gone { flex: 0 0 auto; color: var(--vscode-errorForeground); font-size: 10px; }
    .checkout { visibility: hidden; color: var(--vscode-textLink-foreground); font-size: 11px; }
    .branch-row:hover .checkout { visibility: visible; }
    .toolbar { min-height: 43px; display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
    .toolbar input { min-width: 0; flex: 1; height: 27px; padding: 3px 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); }
    .toolbar button { padding: 5px 8px; border-radius: 3px; }
    .repo-name { max-width: 200px; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
    .list-header, .commit-row { display: grid; grid-template-columns: var(--graph-width) minmax(130px, 1fr) minmax(90px, 140px) 130px; align-items: center; }
    .list-header { min-height: 28px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; }
    .list-header > span { padding: 4px 6px; }
    .commit-list { min-height: 0; overflow: auto; flex: 1; }
    .commit-row { min-height: 34px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); cursor: pointer; }
    .commit-row:hover { background: var(--hover); }
    .commit-row.selected { background: var(--active); }
    .commit-cell { min-width: 0; overflow: hidden; padding: 0 6px; text-overflow: ellipsis; white-space: nowrap; }
    .commit-subject { display: flex; align-items: center; gap: 5px; color: var(--vscode-foreground); }
    .subject-text { min-width: 0; overflow: hidden; flex: 0 1 auto; text-overflow: ellipsis; white-space: nowrap; }
    .ref-badge, .merge-badge { max-width: 110px; overflow: hidden; flex: 0 0 auto; padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); font-size: 10px; text-overflow: ellipsis; }
    .ref-badge.local { color: var(--vscode-charts-blue, #4fc1ff); }
    .ref-badge.remote { color: var(--vscode-charts-purple, #c678dd); }
    .merge-badge { color: var(--vscode-charts-yellow, #e5c07b); }
    .graph { width: auto; height: 34px; justify-self: start; overflow: visible; }
    .detail-head { flex: 0 0 auto; padding: 12px; border-bottom: 1px solid var(--border); }
    .detail-subject { margin: 0 0 10px; font-size: 14px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
    .detail-meta { color: var(--muted); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
    .hash { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); }
    .body { margin-top: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .detail-content > .section-title { flex: 0 0 auto; }
    .files { min-height: 0; flex: 1; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 5px 0 12px; }
    .file { width: 100%; display: flex; align-items: flex-start; gap: 8px; padding: 5px 12px; color: inherit; text-align: left; cursor: pointer; }
    .file:hover { background: var(--hover); }
    .file.added { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #89d185)); }
    .file.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, #f14c4c)); }
    .file.modified, .file.type-changed { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #e5c07b)); }
    .file.renamed { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-textLink-foreground)); }
    .file.conflict { color: var(--vscode-gitDecoration-conflictResourceForeground, var(--vscode-errorForeground)); }
    .file-path { overflow-wrap: anywhere; }
    .file-icon { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
    .file-tree-folder { width: 100%; display: flex; align-items: center; gap: 6px; padding: 5px 8px; color: var(--vscode-foreground); text-align: left; cursor: pointer; }
    .file-tree-folder:hover { background: var(--hover); }
    .file-tree-root { color: var(--vscode-textLink-foreground); }
    .file-tree-chevron { width: 14px; flex: 0 0 14px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; line-height: 1; }
    .file-tree-icon { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
    .file-tree-name { min-width: 0; overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
    .file-tree-count { flex: 0 0 auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .file-tree-children[hidden] { display: none; }
    .load-more { width: 100%; padding: 10px; color: var(--vscode-textLink-foreground); }
    .load-more:hover { background: var(--hover); }
    .empty { padding: 14px 12px; color: var(--muted); line-height: 1.5; }
    @media (max-width: 1000px) {
      .layout { grid-template-columns: minmax(150px, var(--branch-width)) var(--splitter-width) minmax(390px, 1fr); }
      .details, .details-splitter { display: none; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="branches">
      <div class="branch-pane-header">
        <div class="pane-title">分支</div>
        <button id="refresh" class="branch-refresh" type="button" title="刷新分支和提交" aria-label="刷新分支和提交">
          <span class="codicon codicon-refresh" aria-hidden="true"></span>
        </button>
      </div>
      <label class="branch-search"><span aria-hidden="true">⌕</span><input id="branch-search" type="search" placeholder="分支或标签"></label>
      <div id="branch-list"></div>
    </aside>
    <div id="branch-splitter" class="pane-splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整分支面板宽度"></div>
    <main class="main">
      <div class="toolbar">
        <span id="repo-name" class="repo-name"></span>
        <input id="search" type="search" placeholder="搜索提交信息或作者">
      </div>
      <div class="list-header"><span>提交图</span><span>提交信息</span><span>作者</span><span>提交时间</span></div>
      <div id="commit-list" class="commit-list"></div>
    </main>
    <div id="details-splitter" class="pane-splitter details-splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整详情面板宽度"></div>
    <aside class="details">
      <div class="pane-title">提交详情</div>
      <div id="detail-content" class="detail-content empty">选择一条提交以查看详情</div>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const branchList = document.getElementById("branch-list");
    const branchSearchInput = document.getElementById("branch-search");
    const commitList = document.getElementById("commit-list");
    const detailContent = document.getElementById("detail-content");
    const searchInput = document.getElementById("search");
    const colors = ["#4fc1ff", "#e5c07b", "#c678dd", "#98c379", "#e06c75", "#56b6c2", "#d19a66"];
    const collapsedGroups = new Set();
    const collapsedFileFolders = new Set();
    let state = { branches: [], commits: [], currentBranch: "", selectedRef: "", selectedHash: "", repo: "", pathSeparator: "/" };
    const layout = document.querySelector(".layout");
    const branchSplitter = document.getElementById("branch-splitter");
    const detailsSplitter = document.getElementById("details-splitter");
    const restoredWidths = vscode.getState()?.panelWidths || {};
    const panelWidths = {
      branches: readWidth(restoredWidths.branches, 220, 150, 360),
      details: readWidth(restoredWidths.details, 340, 240, 520),
    };

    function readWidth(value, fallback, minimum, maximum) {
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(maximum, Math.max(minimum, value))
        : fallback;
    }

    function isCompactLayout() {
      return window.matchMedia("(max-width: 1000px)").matches;
    }

    function getEffectiveWidths() {
      const compact = isCompactLayout();
      const widths = { ...panelWidths };
      if (compact) {
        widths.branches = Math.min(widths.branches, Math.max(150, layout.clientWidth - 396));
        return widths;
      }
      let overflow = widths.branches + widths.details - (layout.clientWidth - 432);
      if (overflow > 0) {
        const reducedDetails = Math.min(overflow, widths.details - 240);
        widths.details -= reducedDetails;
        overflow -= reducedDetails;
      }
      if (overflow > 0) widths.branches = Math.max(150, widths.branches - overflow);
      return widths;
    }

    function getPaneLimits(pane) {
      const compact = isCompactLayout();
      const widths = getEffectiveWidths();
      if (compact) {
        return pane === "branches"
          ? { minimum: 150, maximum: Math.max(150, Math.min(360, layout.clientWidth - 396)) }
          : { minimum: 240, maximum: 520 };
      }
      return pane === "branches"
        ? {
            minimum: 150,
            maximum: Math.max(150, Math.min(360, layout.clientWidth - 432 - widths.details)),
          }
        : {
            minimum: 240,
            maximum: Math.max(240, Math.min(520, layout.clientWidth - 432 - widths.branches)),
          };
    }

    function applyPanelWidths() {
      const widths = getEffectiveWidths();
      layout.style.setProperty("--branch-width", widths.branches + "px");
      layout.style.setProperty("--details-width", widths.details + "px");
      for (const [splitter, pane, width] of [
        [branchSplitter, "branches", widths.branches],
        [detailsSplitter, "details", widths.details],
      ]) {
        const limits = getPaneLimits(pane);
        splitter.setAttribute("aria-valuemin", String(limits.minimum));
        splitter.setAttribute("aria-valuemax", String(limits.maximum));
        splitter.setAttribute("aria-valuenow", String(Math.round(width)));
        splitter.setAttribute("aria-valuetext", Math.round(width) + " 像素");
      }
    }

    function savePanelWidths() {
      const currentState = vscode.getState();
      vscode.setState({
        ...(currentState && typeof currentState === "object" ? currentState : {}),
        panelWidths: { ...panelWidths },
      });
    }

    function resizePane(pane, width) {
      const limits = getPaneLimits(pane);
      panelWidths[pane] = Math.min(limits.maximum, Math.max(limits.minimum, width));
      applyPanelWidths();
    }

    function attachSplitter(splitter, pane, direction) {
      splitter.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = getEffectiveWidths()[pane];
        const pointerId = event.pointerId;
        let active = true;
        const finish = () => {
          if (!active) return;
          active = false;
          splitter.removeEventListener("pointermove", move);
          splitter.removeEventListener("pointerup", finish);
          splitter.removeEventListener("pointercancel", finish);
          splitter.removeEventListener("lostpointercapture", finish);
          splitter.classList.remove("dragging");
          document.body.classList.remove("resizing");
          savePanelWidths();
          if (splitter.hasPointerCapture(pointerId)) splitter.releasePointerCapture(pointerId);
        };
        const move = (moveEvent) => {
          resizePane(pane, startWidth + (moveEvent.clientX - startX) * direction);
        };
        splitter.setPointerCapture(pointerId);
        splitter.classList.add("dragging");
        document.body.classList.add("resizing");
        splitter.addEventListener("pointermove", move);
        splitter.addEventListener("pointerup", finish);
        splitter.addEventListener("pointercancel", finish);
        splitter.addEventListener("lostpointercapture", finish);
      });
      splitter.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = (event.key === "ArrowRight" ? 1 : -1) * direction * 16;
        resizePane(pane, getEffectiveWidths()[pane] + delta);
        savePanelWidths();
      });
    }

    attachSplitter(branchSplitter, "branches", 1);
    attachSplitter(detailsSplitter, "details", -1);
    applyPanelWidths();
    window.addEventListener("resize", applyPanelWidths);

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function post(message) {
      vscode.postMessage(message);
    }

    function hideBranchContextMenu() {
      document.getElementById("branch-context-menu")?.remove();
    }

    function showBranchContextMenu(branch, x, y) {
      hideBranchContextMenu();
      const menu = element("div", "branch-context-menu");
      menu.id = "branch-context-menu";
      menu.setAttribute("role", "menu");
      const actions = [
        ["pull", "拉取"],
        ["push", "推送"],
        ["update", "更新（拉取后推送）"],
      ];
      for (const [action, label] of actions) {
        const item = element("button", "", label);
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          hideBranchContextMenu();
          post({ type: "branchAction", action, name: branch.name });
        });
        menu.append(item);
      }
      document.body.append(menu);
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth)) + "px";
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight)) + "px";
    }

    document.addEventListener("click", hideBranchContextMenu);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideBranchContextMenu();
    });
    window.addEventListener("resize", hideBranchContextMenu);
    window.addEventListener("scroll", hideBranchContextMenu, true);

    function renderBranches() {
      hideBranchContextMenu();
      branchList.replaceChildren();
      let hasVisibleItems = false;
      const query = branchSearchInput.value.trim().toLocaleLowerCase();
      const matches = (branch) =>
        (branch.name + " " + branch.remote + " " + branch.upstream)
          .toLocaleLowerCase()
          .includes(query);
      function appendSection(label, key, count, depth = 0) {
        const collapsed = collapsedGroups.has(key);
        const header = element("button", "section-row" + (depth ? " remote-folder" : ""));
        header.type = "button";
        header.setAttribute("aria-expanded", String(!collapsed));
        header.append(
          element(
            "span",
            "section-chevron codicon codicon-chevron-" + (collapsed ? "right" : "down"),
          ),
        );
        header.append(element("span", "", label));
        header.append(element("span", "section-count", String(count)));
        header.addEventListener("click", () => {
          if (collapsed) collapsedGroups.delete(key);
          else collapsedGroups.add(key);
          renderBranches();
        });
        branchList.append(header);
        hasVisibleItems = true;
        return !collapsed;
      }

      const locals = state.branches.filter(
        (branch) => branch.kind === "local" && (!query || matches(branch)),
      );
      if (locals.length && appendSection("本地", "local", locals.length)) {
        for (const branch of locals) appendBranch(branch);
      }

      const tags = state.branches.filter(
        (branch) => branch.kind === "tag" && (!query || matches(branch)),
      );
      if (tags.length && appendSection("标签", "tags", tags.length)) {
        for (const branch of tags) appendBranch(branch);
      }

      const allRemotes = new Map();
      for (const branch of state.branches.filter((item) => item.kind === "remote")) {
        const group = allRemotes.get(branch.remote) || [];
        group.push(branch);
        allRemotes.set(branch.remote, group);
      }
      const groups = new Map();
      for (const [remote, branches] of allRemotes) {
        const filtered = branches.filter((branch) => !query || matches(branch));
        if (!query || remote.toLocaleLowerCase().includes(query)) {
          groups.set(remote, branches);
        } else if (filtered.length) {
          groups.set(remote, filtered);
        }
      }
      if (groups.size && appendSection("远程", "remote-root", groups.size)) {
        for (const [remote, branches] of groups) {
          const key = "remote:" + remote;
          if (appendSection(remote, key, branches.length, 1)) {
            for (const branch of branches) appendBranch(branch);
          }
        }
      }

      if (!hasVisibleItems) {
        branchList.append(element("div", "empty", query ? "没有匹配的分支或标签" : "没有分支或标签"));
      }
    }

    function appendBranch(branch) {
      const selected = branch.fullName === state.selectedRef;
      const row = element(
        "button",
        "branch-row " + branch.kind + (selected ? " selected" : ""),
      );
      row.type = "button";
      const isCurrent = branch.kind === "local" && branch.name === state.currentBranch;
      const isTag = branch.kind === "tag";
      const icon = element(
        "span",
        "branch-type" + (isTag ? " tag" : " codicon codicon-git-branch") +
          (isCurrent ? " current" : ""),
        isTag ? "◆" : undefined,
      );
      icon.setAttribute("aria-hidden", "true");
      row.append(icon);
      row.append(element("span", "branch-label", branch.name));
      if (branch.kind === "local" && branch.upstreamGone) {
        row.append(element("span", "tracking-gone", "gone"));
      } else if (branch.kind === "local") {
        if (branch.behind > 0) {
          row.append(element("span", "tracking-count behind", "↙ " + formatCount(branch.behind)));
        }
        if (branch.ahead > 0) {
          row.append(element("span", "tracking-count ahead", "↗ " + formatCount(branch.ahead)));
        }
      }
      if (branch.kind === "local" && !isCurrent) {
        const checkout = element("span", "checkout", "切换");
        checkout.addEventListener("click", (event) => {
          event.stopPropagation();
          post({ type: "checkoutBranch", name: branch.name });
        });
        row.append(checkout);
      }
      row.addEventListener("click", () => post({ type: "selectBranch", ref: branch.fullName }));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (branch.kind === "local") showBranchContextMenu(branch, event.clientX, event.clientY);
      });
      branchList.append(row);
    }

    function formatCount(value) {
      return value > 99 ? "99+" : String(value);
    }

    function renderGraph(commits) {
      const lanes = [];
      const points = [];
      const visibleHashes = new Set(commits.map((commit) => commit.hash));
      commits.forEach((commit, index) => {
        const existingLanes = lanes.slice();
        const compactedLanes = existingLanes.filter(Boolean);
        lanes.splice(0, lanes.length, ...compactedLanes);
        const incomingLane = existingLanes.indexOf(commit.hash);
        let lane = lanes.indexOf(commit.hash);
        if (lane < 0) {
          lane = lanes.indexOf(null);
          if (lane < 0) {
            lane = lanes.length;
            lanes.push(null);
          }
        }
        const incomingFromLane = incomingLane < 0 ? lane : incomingLane;
        lanes[lane] = null;
        const parents = commit.parents.filter((parent) => visibleHashes.has(parent));
        const links = [];
        parents.forEach((parent, parentIndex) => {
          let target = lanes.indexOf(parent);
          if (target < 0) {
            if (parentIndex === 0) {
              target = lane;
            } else {
              target = lanes.indexOf(null);
              if (target < 0) {
                target = lanes.length;
                lanes.push(null);
              }
            }
            lanes[target] = parent;
          }
          links.push({ from: lane, to: target });
        });
        const verticalLanes = existingLanes.flatMap((hash, from) => {
          if (!hash || hash === commit.hash) return [];
          const to = lanes.indexOf(hash);
          return to < 0 ? [] : [{ from, to }];
        });
        const maxLane = Math.max(
          lane,
          incomingFromLane,
          ...verticalLanes.flatMap(({ from, to }) => [from, to]),
          ...links.map(({ from, to }) => Math.max(from, to)),
        );
        points.push({
          lane,
          x: 13 + lane * 14,
          incomingFromLane,
          color: colors[lane % colors.length],
          links,
          hasIncoming: index > 0 && incomingLane >= 0,
          isLast: index === commits.length - 1,
          merge: parents.length > 1,
          maxLane,
          verticalLanes,
        });
      });

      return points.map((point) => {
        const verticals = (point.isLast ? [] : point.verticalLanes).map(({ from, to }) => {
          const x1 = 13 + from * 14;
          const x2 = 13 + to * 14;
          const path = from === to
            ? 'M ' + x1 + ' 0 V 34'
            : 'M ' + x1 + ' 0 L ' + x2 + ' 34';
          return '<path d="' + path + '" fill="none" stroke="' + colors[from % colors.length] + '" stroke-width="2"/>';
        }).join("");
        let incoming = "";
        if (point.hasIncoming) {
          const x = 13 + point.incomingFromLane * 14;
          const path = x === point.x
            ? 'M ' + x + ' 0 V 17'
            : 'M ' + x + ' 0 L ' + point.x + ' 17';
          incoming = '<path d="' + path + '" fill="none" stroke="' + colors[point.incomingFromLane % colors.length] + '" stroke-width="2"/>';
        }
        const segments = (point.isLast ? [] : point.links).map(({ from, to }) => {
          const x1 = 13 + from * 14;
          const x2 = 13 + to * 14;
          const path = from === to
            ? 'M ' + x1 + ' 17 V 34'
            : 'M ' + x1 + ' 17 L ' + x2 + ' 34';
          return '<path d="' + path + '" fill="none" stroke="' + colors[from % colors.length] + '" stroke-width="2"/>';
        }).join("");
        const marker = point.merge
          ? '<circle cx="' + point.x + '" cy="17" r="5" fill="' + point.color + '" stroke="var(--vscode-editor-background)" stroke-width="2"/>'
          : '<circle cx="' + point.x + '" cy="17" r="4" fill="' + point.color + '"/>';
        const width = 24 + point.maxLane * 14;
        return {
          width,
          svg: '<svg class="graph" width="' + width + '" viewBox="0 0 ' + width + ' 34" aria-hidden="true">' + verticals + incoming + segments + marker + '</svg>',
        };
      });
    }

    function renderCommits() {
      commitList.replaceChildren();
      const query = searchInput.value.trim().toLocaleLowerCase();
      const commits = state.commits.filter((commit) =>
        !query || (commit.subject + " " + commit.author).toLocaleLowerCase().includes(query)
      );
      document.documentElement.style.setProperty("--graph-width", "48px");
      if (!commits.length) {
        commitList.append(element("div", "empty", query ? "没有匹配的提交" : "当前分支没有提交记录"));
        return;
      }
      const graphs = renderGraph(commits);
      const graphColumnWidth = Math.max(48, ...graphs.map((graph) => graph.width));
      document.documentElement.style.setProperty("--graph-width", graphColumnWidth + "px");
      commits.forEach((commit, index) => {
        const row = element("div", "commit-row" + (commit.hash === state.selectedHash ? " selected" : ""));
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        const graph = element("span");
        graph.innerHTML = graphs[index].svg;
        row.append(graph.firstElementChild);
        const subject = element("span", "commit-cell commit-subject");
        subject.append(element("span", "subject-text", commit.subject || "(无提交说明)"));
        if (commit.parents.length > 1) {
          subject.append(element("span", "merge-badge", "合并"));
        }
        const refs = state.branches.filter((branch) => branch.commit === commit.hash);
        for (const branch of refs.slice(0, 2)) {
          const label = branch.kind === "remote" ? branch.remote + "/" + branch.name : branch.name;
          subject.append(
            element(
              "span",
              "ref-badge " + branch.kind,
              label,
            ),
          );
        }
        if (refs.length > 2) subject.append(element("span", "ref-badge", "+" + (refs.length - 2)));
        row.append(subject);
        row.append(element("span", "commit-cell muted", commit.author));
        row.append(element("span", "commit-cell muted", formatDate(commit.date)));
        row.addEventListener("click", () => post({ type: "selectCommit", hash: commit.hash }));
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") post({ type: "selectCommit", hash: commit.hash });
        });
        commitList.append(row);
      });
      if (state.hasMore) {
        const button = element("button", "load-more", "加载更多提交");
        button.type = "button";
        button.addEventListener("click", () => {
          button.disabled = true;
          button.textContent = "加载中…";
          post({ type: "loadMore" });
        });
        commitList.append(button);
      }
    }

    function formatDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function renderDetails(detail) {
      detailContent.replaceChildren();
      if (!detail) {
        detailContent.className = "detail-content empty";
        detailContent.textContent = "选择一条提交以查看详情";
        return;
      }
      detailContent.className = "detail-content";
      const head = element("div", "detail-head");
      head.append(element("h2", "detail-subject", detail.subject || "(无提交说明)"));
      head.append(element("div", "detail-meta", detail.author + " <" + detail.email + ">"));
      head.append(element("div", "detail-meta", formatDate(detail.date)));
      head.append(element("div", "detail-meta hash", detail.hash));
      if (detail.parents.length) head.append(element("div", "detail-meta", "父提交：" + detail.parents.map((hash) => hash.slice(0, 10)).join(", ")));
      if (detail.body) head.append(element("div", "body", detail.body));
      detailContent.append(head);
      detailContent.append(element("div", "section-title", "变更文件（" + detail.files.length + "）"));
      const files = element("div", "files");
      if (!detail.files.length) files.append(element("div", "empty", "无文件变更"));
      const root = { directories: new Map(), files: [] };
      for (const file of detail.files) {
        const segments = file.path.split("/");
        const fileName = segments.pop();
        let directory = root;
        for (const segment of segments) {
          if (!directory.directories.has(segment)) {
            directory.directories.set(segment, { directories: new Map(), files: [] });
          }
          directory = directory.directories.get(segment);
        }
        directory.files.push({ ...file, fileName });
      }

      const countFiles = (directory) =>
        directory.files.length +
        [...directory.directories.values()].reduce((sum, child) => sum + countFiles(child), 0);
      const tree = element("div", "file-tree");
      const treeIndent = 20;
      const folderIcons = new Map(detail.folderIcons || []);
      const updateFolderChevron = (chevron, expanded) => {
        chevron.className =
          "file-tree-chevron codicon codicon-chevron-" + (expanded ? "down" : "right");
      };
      const makeFolderRow = (label, count, key, depth, expanded, icons) => {
        const row = element("button", "file-tree-folder" + (depth === 0 ? " file-tree-root" : ""));
        row.type = "button";
        row.setAttribute("aria-expanded", String(expanded));
        row.style.paddingLeft = 8 + depth * treeIndent + "px";
        const chevron = element("span", "file-tree-chevron codicon");
        chevron.setAttribute("aria-hidden", "true");
        updateFolderChevron(chevron, expanded);
        const icon = element("img", "file-tree-icon");
        icon.alt = "";
        icon.setAttribute("aria-hidden", "true");
        icon.src = icons[expanded ? "expanded" : "collapsed"];
        row.append(chevron);
        row.append(icon);
        row.append(element("span", "file-tree-name", label));
        row.append(element("span", "file-tree-count", count + " 个文件"));
        return { row, chevron, icon, icons, key };
      };
      const rootKey = state.repo + ":/";
      const rootExpanded = !collapsedFileFolders.has(rootKey);
      const rootFolderRow = makeFolderRow(
        state.repo || "仓库",
        countFiles(root),
        rootKey,
        0,
        rootExpanded,
        detail.rootFolderIcons,
      );
      const rootContents = element("div", "file-tree-children");
      rootContents.hidden = !rootExpanded;
      rootFolderRow.row.addEventListener("click", () => {
        if (collapsedFileFolders.has(rootKey)) collapsedFileFolders.delete(rootKey);
        else collapsedFileFolders.add(rootKey);
        rootContents.hidden = collapsedFileFolders.has(rootKey);
        rootFolderRow.row.setAttribute("aria-expanded", String(!rootContents.hidden));
        updateFolderChevron(rootFolderRow.chevron, !rootContents.hidden);
        rootFolderRow.icon.src = rootFolderRow.icons[rootContents.hidden ? "collapsed" : "expanded"];
      });
      tree.append(rootFolderRow.row);
      tree.append(rootContents);

      const appendDirectory = (container, directory, parentPath, depth) => {
        for (const [initialName, initialDirectory] of [...directory.directories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const names = [initialName];
          let childDirectory = initialDirectory;
          while (childDirectory.files.length === 0 && childDirectory.directories.size === 1) {
            const [nextName, nextDirectory] = childDirectory.directories.entries().next().value;
            names.push(nextName);
            childDirectory = nextDirectory;
          }
          const directoryPath = [parentPath, ...names].filter(Boolean).join("/");
          const key = state.repo + ":/" + directoryPath;
          const expanded = !collapsedFileFolders.has(key);
          const folder = makeFolderRow(
            names.join(state.pathSeparator),
            countFiles(childDirectory),
            key,
            depth,
            expanded,
            folderIcons.get(directoryPath),
          );
          const contents = element("div", "file-tree-children");
          contents.hidden = !expanded;
          folder.row.addEventListener("click", () => {
            if (collapsedFileFolders.has(key)) collapsedFileFolders.delete(key);
            else collapsedFileFolders.add(key);
            contents.hidden = collapsedFileFolders.has(key);
            folder.row.setAttribute("aria-expanded", String(!contents.hidden));
            updateFolderChevron(folder.chevron, !contents.hidden);
            folder.icon.src = folder.icons[contents.hidden ? "collapsed" : "expanded"];
          });
          container.append(folder.row);
          container.append(contents);
          appendDirectory(contents, childDirectory, directoryPath, depth + 1);
        }
        for (const file of directory.files.sort((a, b) => a.path.localeCompare(b.path))) {
          const statusClass = ({
            A: "added",
            D: "deleted",
            M: "modified",
            T: "type-changed",
            R: "renamed",
            C: "renamed",
            U: "conflict",
          })[file.status] || "";
          const row = element("button", "file" + (statusClass ? " " + statusClass : ""));
          row.type = "button";
          row.style.paddingLeft = 8 + depth * treeIndent + "px";
          const icon = element("img", "file-icon");
          icon.alt = "";
          icon.setAttribute("aria-hidden", "true");
          icon.src = file.iconUri;
          row.append(icon);
          row.append(element("span", "file-path", file.fileName));
          row.title = file.path + "\\n点击在编辑器中查看此提交的差异";
          row.addEventListener("click", () =>
            post({ type: "openDiff", hash: detail.hash, path: file.path }),
          );
          container.append(row);
        }
      };
      appendDirectory(rootContents, root, "", 1);
      files.append(tree);
      detailContent.append(files);
    }

    document.getElementById("repo-name").textContent = state.repo;
    document.getElementById("refresh").addEventListener("click", () => post({ type: "refresh" }));
    branchSearchInput.addEventListener("input", renderBranches);
    searchInput.addEventListener("input", renderCommits);
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        const previousCommits = state.commits;
        state = {
          ...state,
          ...message.data,
          commits: message.data.append
            ? previousCommits.concat(message.data.commits)
            : message.data.commits,
        };
        document.getElementById("repo-name").textContent = state.repo;
        renderBranches();
        renderCommits();
      } else if (message.type === "detail") {
        state.selectedHash = message.data?.hash || "";
        renderCommits();
        renderDetails(message.data);
      }
    });
    post({ type: "ready" });
  </script>
</body>
</html>`;
}

async function loadState(panel, root, selectedRef, skip = 0) {
  const branchData = await getBranches(root);
  const currentBranch = branchData.branches.find(
    (branch) => branch.kind === "local" && branch.name === branchData.currentBranch,
  );
  const activeRef = selectedRef || currentBranch?.fullName || "HEAD";
  const commits = await getCommits(root, activeRef, skip);
  panel.webview.postMessage({
    type: "state",
    data: {
      repo: path.basename(root),
      pathSeparator: path.sep,
      branches: branchData.branches,
      currentBranch: branchData.currentBranch,
      commits,
      selectedRef: activeRef,
      append: skip > 0,
      hasMore: commits.length === MAX_COMMITS,
    },
  });
  return { count: commits.length, selectedRef: activeRef };
}

function activate(context) {
  const vscodeIconsExtension = vscode.extensions.getExtension("vscode-icons-team.vscode-icons");
  if (!vscodeIconsExtension) {
    throw new Error("需要安装 vscode-icons 扩展才能显示文件图标。");
  }
  const vscodeIconsTheme = readVscodeIconsTheme(vscodeIconsExtension);
  const codiconsCssPath = path.join(
    context.extensionUri.fsPath,
    "node_modules",
    "@vscode",
    "codicons",
    "dist",
    "codicon.css",
  );
  if (!fs.existsSync(codiconsCssPath)) {
    throw new Error("无法加载 Codicons 样式，请重新安装 IDEA Git Log 扩展。");
  }
  const provider = {
    resolveWebviewView(view) {
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri, vscodeIconsExtension.extensionUri],
      };
      const codiconsCssUri = view.webview.asWebviewUri(vscode.Uri.file(codiconsCssPath));
      view.webview.html = getWebviewHtml(view.webview, codiconsCssUri);
      const iconResolver = createIconResolver(
        view.webview,
        vscodeIconsTheme,
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light,
      );

      let root = "";
      let selectedRef = "";
      let loadedCount = 0;
      const resolveRoot = async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        if (!workspaceFolders.length) {
          throw new Error("请先在 VS Code 中打开一个 Git 仓库。");
        }
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const activeWorkspace = activeUri
          ? vscode.workspace.getWorkspaceFolder(activeUri)
          : undefined;
        const candidates = [
          activeWorkspace,
          ...workspaceFolders.filter((folder) => folder !== activeWorkspace),
        ].filter(Boolean);
        let nextRoot = "";
        let lastError;
        for (const folder of candidates) {
          try {
            nextRoot = await getRepository(folder.uri.fsPath);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!nextRoot) {
          const detail = lastError instanceof Error ? `：${lastError.message}` : "";
          throw new Error(`当前工作区中未找到 Git 仓库${detail}`);
        }
        if (root !== nextRoot) {
          root = nextRoot;
          selectedRef = "";
          loadedCount = 0;
        }
      };

      const refreshSelectedBranch = async () => {
        loadedCount = 0;
        const result = await loadState(view, root, selectedRef);
        loadedCount = result.count;
        selectedRef = result.selectedRef;
      };

      const switchToBranch = async (branch, currentBranch) => {
        const alreadyCurrent = branch.name === currentBranch;
        if (!alreadyCurrent) {
          const status = await runGit(root, ["status", "--porcelain=v1"]);
          if (status.trim()) {
            throw new Error("工作区有未提交更改。请先提交或暂存更改，再切换分支。");
          }
          await runGit(root, ["switch", "--no-guess", branch.name]);
        }
        selectedRef = branch.fullName;
        view.webview.postMessage({ type: "detail", data: null });
        await refreshSelectedBranch();
        return !alreadyCurrent;
      };

      const messageSubscription = view.webview.onDidReceiveMessage(async (message) => {
        try {
          if (message.type === "ready" || message.type === "refresh") {
            await resolveRoot();
            const result = await loadState(view, root, selectedRef);
            loadedCount = result.count;
            selectedRef = result.selectedRef;
            if (message.type === "refresh") {
              vscode.window.setStatusBarMessage("Git Log 已刷新", 1500);
            }
          } else if (message.type === "selectBranch") {
            const requested = message.ref;
            if (!/^(refs\/heads\/|refs\/remotes\/|refs\/tags\/)/.test(requested)) {
              throw new Error("无效的分支引用");
            }
            const { branches } = await getBranches(root);
            if (!branches.some((branch) => branch.fullName === requested)) {
              throw new Error("该分支已不存在，请刷新后重试");
            }
            selectedRef = requested;
            loadedCount = 0;
            view.webview.postMessage({ type: "detail", data: null });
            loadedCount = (await loadState(view, root, selectedRef)).count;
          } else if (message.type === "loadMore") {
            const result = await loadState(view, root, selectedRef, loadedCount);
            loadedCount += result.count;
          } else if (message.type === "selectCommit") {
            const detail = await getCommitDetails(root, message.hash);
            const folders = new Map();
            for (const file of detail.files) {
              file.iconUri = iconResolver.iconForFile(file.path);
              const segments = file.path.split("/").slice(0, -1);
              for (let index = 1; index <= segments.length; index += 1) {
                const directoryPath = segments.slice(0, index).join("/");
                if (!folders.has(directoryPath)) {
                  const directorySegments = segments.slice(0, index);
                  folders.set(directoryPath, {
                    collapsed: iconResolver.iconForFolder(directorySegments, false),
                    expanded: iconResolver.iconForFolder(directorySegments, true),
                  });
                }
              }
            }
            detail.rootFolderIcons = {
              collapsed: iconResolver.iconForFolder([], false, true),
              expanded: iconResolver.iconForFolder([], true, true),
            };
            detail.folderIcons = [...folders.entries()];
            view.webview.postMessage({ type: "detail", data: detail });
          } else if (message.type === "openDiff") {
            await openCommitFileDiff(root, message.hash, message.path);
          } else if (message.type === "branchAction") {
            if (!["pull", "push", "update"].includes(message.action)) {
              throw new Error("无效的分支操作");
            }
            await resolveRoot();
            const { branches, currentBranch } = await getBranches(root);
            const branch = branches.find(
              (candidate) => candidate.kind === "local" && candidate.name === message.name,
            );
            if (!branch) throw new Error("找不到要操作的本地分支");
            await switchToBranch(branch, currentBranch);
            if (message.action !== "push") {
              await runGit(root, ["pull"]);
              await refreshSelectedBranch();
            }
            if (message.action !== "pull") {
              await runGit(root, ["push"]);
              await refreshSelectedBranch();
            }
            const actionLabel = {
              pull: "已拉取",
              push: "已推送",
              update: "已更新（拉取后推送）",
            }[message.action];
            vscode.window.showInformationMessage(`${actionLabel}分支 ${branch.name}`);
          } else if (message.type === "checkoutBranch") {
            const { branches, currentBranch } = await getBranches(root);
            const branch = branches.find(
              (candidate) => candidate.kind === "local" && candidate.name === message.name,
            );
            if (!branch) throw new Error("找不到要切换的本地分支");
            if (!(await switchToBranch(branch, currentBranch))) return;
            vscode.window.showInformationMessage(`已切换到分支 ${branch.name}`);
          }
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(messageText);
        }
      });
      view.onDidDispose(() => messageSubscription.dispose());
    },
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("idea-git-log", {
      async provideTextDocumentContent(uri) {
        const { root, revision, filePath, empty } = JSON.parse(
          Buffer.from(uri.query, "base64url").toString("utf8"),
        );
        if (empty) return "";
        const content = await runGit(root, ["show", `${revision}:${filePath}`]);
        return content.includes("\0")
          ? `[Binary file: ${filePath}]`
          : content;
      },
    }),
    vscode.window.registerWebviewViewProvider("ideaGitLog.sidebarView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("ideaGitLog.open", () =>
      vscode.commands.executeCommand("ideaGitLog.sidebarView.focus"),
    ),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
