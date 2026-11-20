/** Profile manager (spec §1): load, migrate, save, duplicate, import/export. */
import { create } from 'zustand';
import { backend } from '@/lib/backend';
import { migrateProfile } from '@/lib/profile/migrate';
import { newId, profileFromPreset } from '@/lib/profile/presets';
import { type MachineProfile, validateProfile } from '@/lib/profile/schema';
import { exportFileName, exportProfile, type ImportResult, parseProfileImport } from '@/lib/profile/share';
import { errorMessage } from '@/lib/utils';
import { useApp } from './app';
import { setProfileNameGetter } from './link';

interface ProfilesStore {
  loaded: boolean;
  profiles: MachineProfile[];
  /** Files that could not be loaded/migrated — shown, never silently dropped. */
  loadProblems: string[];
  /** Notices about migrated profiles. */
  notices: string[];
  activeId: string | null;
  load(): Promise<void>;
  active(): MachineProfile | null;
  setActive(id: string): void;
  save(p: MachineProfile): Promise<void>;
  createFromPreset(presetId: string, name?: string): MachineProfile;
  duplicate(id: string): Promise<MachineProfile>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  parseImport(text: string): ImportResult;
  exportToFile(id: string): Promise<boolean>;
  importFromFile(): Promise<ImportResult | null>;
}

const sortByName = (a: MachineProfile, b: MachineProfile) => a.identity.name.localeCompare(b.identity.name);

export const useProfiles = create<ProfilesStore>((set, get) => ({
  loaded: false,
  profiles: [],
  loadProblems: [],
  notices: [],
  activeId: null,

  async load() {
    const problems: string[] = [];
    const notices: string[] = [];
    const profiles: MachineProfile[] = [];
    let raws: unknown[] = [];
    try {
      raws = await backend.listProfiles();
    } catch (e) {
      problems.push(`Could not read saved profiles: ${errorMessage(e)}`);
    }
    for (const raw of raws) {
      const m = migrateProfile(raw);
      const label = (raw as { identity?: { name?: string } })?.identity?.name ?? (raw as { id?: string })?.id ?? 'unnamed';
      if (!m.ok) {
        problems.push(`"${label}" could not be loaded: ${Object.entries(m.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        continue;
      }
      profiles.push(m.profile);
      if (m.migratedFrom !== null) {
        notices.push(`"${m.profile.identity.name}" was upgraded to the current profile format.`);
        await backend.saveProfile(m.profile).catch((e) => problems.push(`Could not save upgraded "${label}": ${errorMessage(e)}`));
      }
    }
    profiles.sort(sortByName);
    const wanted = useApp.getState().settings.activeProfileId;
    const activeId = profiles.find((p) => p.id === wanted)?.id ?? profiles[0]?.id ?? null;
    set({ loaded: true, profiles, loadProblems: problems, notices, activeId });
  },

  active() {
    const { profiles, activeId } = get();
    return profiles.find((p) => p.id === activeId) ?? null;
  },

  setActive(id) {
    if (!get().profiles.some((p) => p.id === id)) return;
    set({ activeId: id });
    useApp.getState().update((s) => ({ ...s, activeProfileId: id }));
  },

  async save(p) {
    const v = validateProfile({ ...p, updatedAt: new Date().toISOString() });
    if (!v.ok || !v.profile) {
      throw new Error(`Profile is not valid: ${Object.entries(v.errors).map(([k, m]) => `${k}: ${m}`).join('; ')}`);
    }
    await backend.saveProfile(v.profile);
    const others = get().profiles.filter((x) => x.id !== v.profile!.id);
    set({ profiles: [...others, v.profile].sort(sortByName) });
    if (!get().activeId) get().setActive(v.profile.id);
  },

  createFromPreset(presetId, name) {
    return profileFromPreset(presetId, name);
  },

  async duplicate(id) {
    const src = get().profiles.find((p) => p.id === id);
    if (!src) throw new Error('profile not found');
    const now = new Date().toISOString();
    const copy: MachineProfile = {
      ...structuredClone(src),
      id: newId(),
      createdAt: now,
      updatedAt: now,
      identity: { ...src.identity, name: `${src.identity.name} copy`.slice(0, 60) },
    };
    await get().save(copy);
    return copy;
  },

  async rename(id, name) {
    const p = get().profiles.find((x) => x.id === id);
    if (!p) return;
    await get().save({ ...p, identity: { ...p.identity, name: name.trim().slice(0, 60) } });
  },

  async remove(id) {
    await backend.deleteProfile(id);
    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    if (get().activeId === id) {
      const next = profiles[0]?.id ?? null;
      set({ activeId: next });
      useApp.getState().update((s) => ({ ...s, activeProfileId: next }));
    }
  },

  parseImport(text) {
    return parseProfileImport(text, get().profiles.map((p) => p.identity.name));
  },

  async exportToFile(id) {
    const p = get().profiles.find((x) => x.id === id);
    if (!p) return false;
    return backend.saveTextFile({
      title: 'Export machine profile',
      defaultName: exportFileName(p),
      filters: [{ name: 'Machine profile', extensions: ['json'] }],
      text: exportProfile(p),
    });
  },

  async importFromFile() {
    const file = await backend.openTextFile({ title: 'Import machine profile', filters: [{ name: 'Machine profile', extensions: ['json'] }] });
    if (!file) return null;
    return get().parseImport(file.text);
  },
}));

/** Convenience hook: the active profile (or null). */
export function useActiveProfile(): MachineProfile | null {
  return useProfiles((s) => s.profiles.find((p) => p.id === s.activeId) ?? null);
}

// Lets the link store label job history entries without importing this module.
setProfileNameGetter(() => useProfiles.getState().active()?.identity.name ?? '');
