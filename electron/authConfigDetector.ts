import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH0_KEY_PATTERN = /^(AUTH0_BASE_URL|APP_BASE_URL|AUTH0_ISSUER_BASE_URL)=/m;
const DOTENV_LOAD_ORDER = ['.env.local', '.env.development.local', '.env.development', '.env'];
const AUTH0_CONFIG_FILES = ['auth0.config.js', 'auth0.config.ts'];
const AUTH0_PACKAGES = ['@auth0/nextjs-auth0', 'express-openid-connect'];

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function envFileContainsAuth0(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return AUTH0_KEY_PATTERN.test(content);
  } catch {
    return false;
  }
}

export async function detectAuth0Config(repoPath: string): Promise<boolean> {
  for (const envFile of DOTENV_LOAD_ORDER) {
    if (await envFileContainsAuth0(path.join(repoPath, envFile))) {
      return true;
    }
  }

  for (const configFile of AUTH0_CONFIG_FILES) {
    if (await fileExists(path.join(repoPath, configFile))) {
      return true;
    }
  }

  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(repoPath, 'package.json'), 'utf8'));
    const deps = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.devDependencies ?? {}) };
    if (AUTH0_PACKAGES.some((pkg) => pkg in deps)) {
      return true;
    }
  } catch {
    // no package.json or unparseable — not Auth0
  }

  return false;
}
