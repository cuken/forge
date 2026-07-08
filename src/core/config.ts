import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeConfig } from './types.js';

export function readForgeConfigSync(root = process.cwd()): Partial<ForgeConfig> | null {
  const toml = readForgeTomlConfigSync(root);
  if (toml) return toml;
  try {
    return JSON.parse(readFileSync(join(root, '.forge', 'config.json'), 'utf8')) as Partial<ForgeConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readForgeTomlConfigSync(root: string): Partial<ForgeConfig> | null {
  try {
    return parseForgeToml(readFileSync(join(root, '.forge', 'config.toml'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseForgeToml(input: string): Partial<ForgeConfig> {
  const config: Partial<ForgeConfig> = {};
  let section = '';
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const arrayAssignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\[(.*)\]\s*$/);
    if (arrayAssignment) {
      const [, key, rawValues] = arrayAssignment;
      const values = [...rawValues.matchAll(/"([^"]*)"/g)].map(match => match[1]);
      if (section === 'validation' && key === 'commands') config.validation = { ...config.validation, commands: values };
      continue;
    }
    const booleanAssignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*$/);
    if (booleanAssignment) {
      const [, key, rawValue] = booleanAssignment;
      const value = rawValue === 'true';
      if (section === 'daemon' && key === 'syncAcceptedWork') config.daemon = { ...config.daemon, syncAcceptedWork: value };
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (section === 'providers') {
      config.providers = { store: '', vcs: '', workspace: '', agent: '', ...config.providers, [key]: value };
    } else if (section === 'linear') {
      config.linear = { ...config.linear, [key]: value };
    } else if (section === 'github') {
      config.github = { ...config.github, [key]: value };
    } else if (section === 'notifications') {
      config.notifications = { ...config.notifications, [key]: value };
    }
  }
  return config;
}
