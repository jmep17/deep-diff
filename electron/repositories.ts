import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitHubBranchRequest,
  GitHubRepositoryRequest,
  RepositorySummary,
  WorkspaceSelection,
} from './types.js';

const execFileAsync = promisify(execFile);

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageName(repoPath: string) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(repoPath, 'package.json'), 'utf8'));
    return typeof packageJson.name === 'string' ? packageJson.name : undefined;
  } catch {
    return undefined;
  }
}

async function getDefaultBranch(repoPath: string) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const current = stdout.trim();
    if (current) return current;
  } catch {
    // Fall through to common branch names.
  }

  const branches = await listLocalBranches(repoPath);
  return branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branches[0];
}

async function toRepositorySummary(repoPath: string): Promise<RepositorySummary> {
  const packageName = await readPackageName(repoPath);
  const folderName = path.basename(repoPath);
  const defaultBranch = await getDefaultBranch(repoPath);

  return {
    id: repoPath,
    name: packageName ?? folderName,
    fullName: packageName ?? folderName,
    source: 'local',
    path: repoPath,
    defaultBranch,
  };
}

export async function scanWorkspace(workspacePath: string): Promise<WorkspaceSelection> {
  const repositories: RepositorySummary[] = [];

  if (await pathExists(path.join(workspacePath, '.git'))) {
    repositories.push(await toRepositorySummary(workspacePath));
    return { workspacePath, repositories };
  }

  const entries = await fs.readdir(workspacePath, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(workspacePath, entry.name));

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, '.git'))) {
      repositories.push(await toRepositorySummary(candidate));
    }
  }

  repositories.sort((a, b) => a.name.localeCompare(b.name));
  return { workspacePath, repositories };
}

export async function listLocalBranches(repoPath: string) {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoPath,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);

  return stdout
    .split('\n')
    .map((branch) => branch.trim())
    .filter(Boolean)
    .sort((a, b) => {
      if (a === 'main') return -1;
      if (b === 'main') return 1;
      if (a === 'master') return -1;
      if (b === 'master') return 1;
      return a.localeCompare(b);
    });
}

function githubHeaders(token?: string) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Extract the `rel="next"` URL from a GitHub `Link` response header (paginated
// list endpoints). Returns null when there is no next page.
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

// Fetch every page of a GitHub list endpoint, following the `Link: rel="next"`
// header, and concatenate the results. Without this, list endpoints silently
// cap at `per_page` (max 100) — repos/branches beyond that were dropped.
async function githubRequestAll<T>(url: string, token?: string): Promise<T[]> {
  const results: T[] = [];
  let next: string | null = url;
  let pages = 0;
  while (next && pages < 50) {
    // hard cap guards against a pathological cycle
    const response = await fetch(next, { headers: githubHeaders(token) });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub request failed (${response.status}): ${detail}`);
    }
    results.push(...((await response.json()) as T[]));
    next = parseNextLink(response.headers.get('link'));
    pages += 1;
  }
  return results;
}

interface GitHubRepositoryPayload {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string };
}

interface GitHubBranchPayload {
  name: string;
}

export async function fetchGitHubRepositories(request: GitHubRepositoryRequest) {
  const organization = request.organization.trim();
  if (!organization) {
    throw new Error('GitHub organization or user is required.');
  }

  const query = '?per_page=100&sort=updated';
  const name = encodeURIComponent(organization);
  let repos: GitHubRepositoryPayload[];
  try {
    repos = await githubRequestAll<GitHubRepositoryPayload>(
      `https://api.github.com/orgs/${name}/repos${query}`,
      request.token,
    );
  } catch {
    // Not an organization (404) — fall back to a personal account's repos.
    repos = await githubRequestAll<GitHubRepositoryPayload>(
      `https://api.github.com/users/${name}/repos${query}`,
      request.token,
    );
  }

  return repos.map<RepositorySummary>((repo) => ({
    id: `github:${repo.id}`,
    name: repo.name,
    fullName: repo.full_name,
    source: 'github',
    owner: repo.owner.login,
    defaultBranch: repo.default_branch,
    description: repo.description,
    private: repo.private,
    url: repo.html_url,
  }));
}

export async function fetchGitHubBranches(request: GitHubBranchRequest) {
  if (!request.owner.trim() || !request.repository.trim()) {
    throw new Error('GitHub owner and repository are required.');
  }

  const branches = await githubRequestAll<GitHubBranchPayload>(
    `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(
      request.repository,
    )}/branches?per_page=100`,
    request.token,
  );

  return branches.map((branch) => branch.name);
}
