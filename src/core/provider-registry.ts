import type { ForgeProvider } from './types.js';

export type ProviderFactory<T extends ForgeProvider = ForgeProvider> = () => T;

interface ProviderEntry<T extends ForgeProvider = ForgeProvider> {
  kind: T['kind'];
  id: string;
  aliases: string[];
  create: ProviderFactory<T>;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();

  register<T extends ForgeProvider>(input: { kind: T['kind']; id: string; aliases?: string[]; create: ProviderFactory<T> }) {
    const keys = [input.id, ...(input.aliases ?? [])];
    for (const key of keys) {
      const existing = this.entries.get(this.key(input.kind, key));
      if (existing) throw new Error(`Provider '${key}' is already registered for kind '${input.kind}' as '${existing.id}'.`);
    }
    const entry: ProviderEntry<T> = { kind: input.kind, id: input.id, aliases: input.aliases ?? [], create: input.create };
    for (const key of keys) this.entries.set(this.key(input.kind, key), entry);
    return this;
  }

  create<T extends ForgeProvider>(kind: T['kind'], requested: string): T {
    const entry = this.entries.get(this.key(kind, requested));
    if (!entry) throw new Error(`Unknown ${kind} provider '${requested}'. Expected ${this.expected(kind)}.`);
    return entry.create() as T;
  }

  optional<T extends ForgeProvider>(kind: T['kind'], requested?: string): T | undefined {
    return requested ? this.create<T>(kind, requested) : undefined;
  }

  ids(kind: string) {
    const seen = new Set<string>();
    for (const entry of this.entries.values()) if (entry.kind === kind) seen.add(entry.id);
    return [...seen].sort();
  }

  expected(kind: string) {
    const names = new Set<string>();
    for (const entry of this.entries.values()) if (entry.kind === kind) { names.add(entry.id); for (const alias of entry.aliases) names.add(alias); }
    return [...names].sort().join(', ') || '(none registered)';
  }

  private key(kind: string, id: string) { return `${kind}:${id}`; }
}
