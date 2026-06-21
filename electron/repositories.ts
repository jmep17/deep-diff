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

async function githubRequest<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${detail}`);
  }
  return response.json() as Promise<T>;
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
    throw new Error('GitHub organization is required.');
  }

  const repos = await githubRequest<GitHubRepositoryPayload[]>(
    `https://api.github.com/orgs/${encodeURIComponent(organization)}/repos?per_page=100&sort=updated`,
    request.token,
  );

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

  const branches = await githubRequest<GitHubBranchPayload[]>(
    `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(
      request.repository,
    )}/branches?per_page=100`,
    request.token,
  );

  return branches.map((branch) => branch.name);
}
