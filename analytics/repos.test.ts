import { test } from "node:test";
import assert from "node:assert/strict";
import {
  envIdFromPath,
  type KnownProject,
  matchProjectByLeaf,
  matchProjectByPath,
  NO_REPO,
  normalizeRemote,
  resolveRepo,
  threadIdFromPath,
} from "./repos.ts";

const PROJECTS: KnownProject[] = [
  { name: "MGrin/agentic-brain", paths: ["/Users/mgrin/Projects/mgrin/agentic-brain"] },
  { name: "MGrin/dotfiles", paths: ["/Users/mgrin/Dev/dotfiles"] },
  { name: "Flarexyz/motion", paths: ["/Users/mgrin/Projects/flare/motion"] },
  {
    name: "Flarexyz/motion-client-dashboard-ops",
    paths: ["/Users/mgrin/Projects/flare/motion-client-dashboard-ops"],
  },
];

test("normalizeRemote handles every url shape git produces", () => {
  assert.equal(normalizeRemote("https://github.com/MGrin/agentic-brain.git"), "MGrin/agentic-brain");
  assert.equal(normalizeRemote("https://github.com/MGrin/agentic-brain"), "MGrin/agentic-brain");
  assert.equal(normalizeRemote("git@github.com:Flarexyz/motion.git"), "Flarexyz/motion");
  assert.equal(normalizeRemote("ssh://git@github.com/MGrin/scani.git"), "MGrin/scani");
  assert.equal(normalizeRemote("  https://github.com/MGrin/scani.git  "), "MGrin/scani");
});

test("normalizeRemote refuses what it cannot read rather than guessing", () => {
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(""), null);
  assert.equal(normalizeRemote("   "), null);
  // A filesystem remote names no host. Turning it into "local/path" would put
  // a fabricated repo in the breakdown, which reads as an answer.
  assert.equal(normalizeRemote("/some/local/path"), null);
  assert.equal(normalizeRemote("file:///some/local/path"), null);
  assert.equal(normalizeRemote("nonsense"), null);
  assert.equal(normalizeRemote("https://github.com/onlyowner"), null);
});

test("envIdFromPath finds the environment in bb-managed paths", () => {
  assert.equal(envIdFromPath("/Users/mgrin/.bb/personal-workspaces/env_4dcqxu7kgg"), "env_4dcqxu7kgg");
  assert.equal(envIdFromPath("/Users/mgrin/.bb/worktrees/env_zwej6b4t8z/agentic-brain"), "env_zwej6b4t8z");
  assert.equal(envIdFromPath("/Users/mgrin/.bb/worktrees/env_77tw9w4w38/motion/src/x"), "env_77tw9w4w38");
  assert.equal(envIdFromPath("/Users/mgrin/Projects/mgrin/agentic-brain"), null);
});

test("threadIdFromPath finds thread-storage paths", () => {
  assert.equal(threadIdFromPath("/Users/mgrin/.bb/thread-storage/thr_xc4xs9b5wu"), "thr_xc4xs9b5wu");
  assert.equal(threadIdFromPath("/Users/mgrin/Projects/mgrin/agentic-brain"), null);
});

test("matchProjectByPath resolves a directory inside a project", () => {
  assert.equal(
    matchProjectByPath("/Users/mgrin/Projects/mgrin/agentic-brain/src/deep/dir", PROJECTS),
    "MGrin/agentic-brain",
  );
  assert.equal(matchProjectByPath("/Users/mgrin/Projects/mgrin/agentic-brain", PROJECTS), "MGrin/agentic-brain");
});

test("matchProjectByPath resolves a worktree nested inside the project path", () => {
  // Real: this directory no longer exists, but its owner is not in doubt.
  assert.equal(
    matchProjectByPath("/Users/mgrin/Projects/mgrin/agentic-brain/wt/core-and-seams", PROJECTS),
    "MGrin/agentic-brain",
  );
});

test("matchProjectByPath takes the LONGEST prefix, not the first", () => {
  const nested: KnownProject[] = [
    { name: "Owner/outer", paths: ["/repos/outer"] },
    { name: "Owner/inner", paths: ["/repos/outer/vendor/inner"] },
  ];
  assert.equal(matchProjectByPath("/repos/outer/vendor/inner/src", nested), "Owner/inner");
  assert.equal(matchProjectByPath("/repos/outer/src", nested), "Owner/outer");
});

test("matchProjectByPath does not match a sibling with a shared prefix", () => {
  // motion-client-dashboard-ops must never be filed under motion.
  assert.equal(
    matchProjectByPath("/Users/mgrin/Projects/flare/motion-client-dashboard-ops/src", PROJECTS),
    "Flarexyz/motion-client-dashboard-ops",
  );
});

test("matchProjectByLeaf recovers a deleted worktree from its directory name", () => {
  assert.equal(
    matchProjectByLeaf("/Users/mgrin/.bb/worktrees/env_zwej6b4t8z/agentic-brain", PROJECTS),
    "MGrin/agentic-brain",
  );
});

test("matchProjectByLeaf never invents a repo bb does not know", () => {
  assert.equal(matchProjectByLeaf("/Users/mgrin/.bb/worktrees/env_x/some-random-dir", PROJECTS), null);
});

test("resolution order: project path beats environment and git", () => {
  const r = resolveRepo("/Users/mgrin/Projects/mgrin/agentic-brain/x", {
    projects: PROJECTS,
    environmentProject: "Wrong/one",
    gitRemote: "https://github.com/Wrong/two.git",
  });
  assert.deepEqual(r, { repo: "MGrin/agentic-brain", source: "project-path" });
});

test("resolution order: environment beats git for bb-managed paths", () => {
  const r = resolveRepo("/Users/mgrin/.bb/worktrees/env_a/whatever", {
    projects: PROJECTS,
    environmentProject: "Flarexyz/motion",
    gitRemote: "https://github.com/Wrong/two.git",
  });
  assert.deepEqual(r, { repo: "Flarexyz/motion", source: "environment" });
});

test("git answers when bb knows nothing about the path", () => {
  const r = resolveRepo("/Users/mgrin/somewhere/else", {
    projects: PROJECTS,
    gitRemote: "git@github.com:Someone/other.git",
  });
  assert.deepEqual(r, { repo: "Someone/other", source: "git-remote" });
});

test("a deleted worktree with no environment record still resolves by leaf", () => {
  const r = resolveRepo("/Users/mgrin/.bb/worktrees/env_gone/agentic-brain", {
    projects: PROJECTS,
    environmentProject: null,
    gitRemote: null,
  });
  assert.deepEqual(r, { repo: "MGrin/agentic-brain", source: "leaf-name" });
});

test("work that belongs to no repo says so rather than guessing", () => {
  assert.deepEqual(resolveRepo("/Users/mgrin", { projects: PROJECTS }), { repo: NO_REPO, source: "none" });
  assert.deepEqual(
    resolveRepo("/Users/mgrin/.bb/personal-workspaces/env_4dcqxu7kgg", { projects: PROJECTS }),
    { repo: NO_REPO, source: "none" },
  );
});
