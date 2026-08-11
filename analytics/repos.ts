// Which GitHub repo did this burn belong to? Pure.
//
// `cwd` is the only location a transcript records, and asking git is not
// enough on its own: 65 of the 145 directories in this machine's archive no
// longer exist, because bb worktrees are disposable and get cleaned up. The
// two biggest single entries are a retired personal workspace and a worktree
// path whose directory is gone — between them a third of all burn — so a
// git-only resolver would file a third of the answer under "unknown".
//
// So resolution is layered, cheapest and most durable first, and every layer
// records WHICH one answered so a wrong label can be traced rather than
// guessed at.

export interface KnownProject {
  /** bb's project name, already in owner/repo form. */
  name: string;
  /** Absolute local paths bb associates with the project. */
  paths: string[];
}

export type RepoSource = "project-path" | "environment" | "git-remote" | "leaf-name" | "none";

export interface RepoResolution {
  repo: string;
  source: RepoSource;
}

/** Work that legitimately belongs to no repository. */
export const NO_REPO = "(no repo)";

/**
 * `git@github.com:Owner/name.git`, `https://github.com/Owner/name.git` and
 * `https://github.com/Owner/name` all describe the same repo.
 *
 * A remote must actually name a HOST. Accepting a bare path would turn a
 * filesystem remote — `/some/local/path` — into the plausible-looking repo
 * "local/path", and a fabricated label in a breakdown is worse than an honest
 * "(no repo)": it looks like an answer.
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const withoutSuffix = url.trim().replace(/\.git$/, "");
  if (withoutSuffix === "") return null;

  const scp = withoutSuffix.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  const scheme = withoutSuffix.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  const path = scp ? scp[2]! : scheme ? scheme[2]! : null;
  if (path === null) return null;

  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return segments.slice(-2).join("/");
}

/** The `env_xxx` in a bb-managed path, if there is one. */
export function envIdFromPath(cwd: string): string | null {
  const m = cwd.match(/\/(?:worktrees|personal-workspaces)\/(env_[a-z0-9]+)(?:\/|$)/i);
  return m ? m[1]! : null;
}

/** The `thr_xxx` in a bb thread-storage path, if there is one. */
export function threadIdFromPath(cwd: string): string | null {
  const m = cwd.match(/\/thread-storage\/(thr_[a-z0-9]+)(?:\/|$)/i);
  return m ? m[1]! : null;
}

const isBeneath = (cwd: string, root: string): boolean =>
  cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Longest-prefix match against bb's known project paths.
 *
 * Longest rather than first: a repo checked out inside another repo's
 * directory must win over its parent, and this machine really does have
 * `Projects/mgrin/agentic-brain/wt/core-and-seams` — a worktree nested inside
 * the project path, whose directory no longer exists but whose owner is not
 * in doubt.
 */
export function matchProjectByPath(cwd: string, projects: KnownProject[]): string | null {
  let best: { name: string; length: number } | null = null;
  for (const project of projects) {
    for (const root of project.paths) {
      if (!isBeneath(cwd, root)) continue;
      if (best === null || root.length > best.length) best = { name: project.name, length: root.length };
    }
  }
  return best?.name ?? null;
}

/**
 * Last resort: a bb worktree is laid out as `env_xxx/<repo-name>`, so the leaf
 * still names the repo even when both the directory and the environment record
 * are gone. Only accepted when it matches a project bb actually knows, so this
 * can never invent a repository out of a directory name.
 */
export function matchProjectByLeaf(cwd: string, projects: KnownProject[]): string | null {
  const segments = cwd.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    const hit = projects.find((p) => p.name.split("/").pop() === segment);
    if (hit) return hit.name;
  }
  return null;
}

export interface ResolveInputs {
  projects: KnownProject[];
  /** bb project name for the environment owning this path, when known. */
  environmentProject?: string | null;
  /** `git config --get remote.origin.url` for this path, when it still exists. */
  gitRemote?: string | null;
}

/**
 * Resolve one working directory to a repo label.
 *
 * Order is deliberate. Project paths first because they are bb's own record
 * and survive the directory being deleted. The environment next, for
 * bb-managed paths. git only third — it is the most authoritative answer but
 * the least available, since it needs the directory to still exist. Leaf-name
 * matching last, and only against projects bb knows.
 */
export function resolveRepo(cwd: string, inputs: ResolveInputs): RepoResolution {
  const byPath = matchProjectByPath(cwd, inputs.projects);
  if (byPath) return { repo: byPath, source: "project-path" };

  if (inputs.environmentProject) {
    return { repo: inputs.environmentProject, source: "environment" };
  }

  const byGit = normalizeRemote(inputs.gitRemote);
  if (byGit) return { repo: byGit, source: "git-remote" };

  const byLeaf = matchProjectByLeaf(cwd, inputs.projects);
  if (byLeaf) return { repo: byLeaf, source: "leaf-name" };

  return { repo: NO_REPO, source: "none" };
}
