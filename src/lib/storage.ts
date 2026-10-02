/**
 * ブラウザ内保存 (IndexedDB)。idb-keyval で key-value として保存する。
 *   boxglow:index              -> ProjectMeta[] (一覧)
 *   boxglow:project:<id>       -> Project
 */
import { del, get, set } from "idb-keyval";
import type { Project } from "../model/types";

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
}

const INDEX_KEY = "boxglow:index";
const projectKey = (id: string): string => `boxglow:project:${id}`;

/** 一覧を読む (更新日時の新しい順) */
export async function listProjects(): Promise<ProjectMeta[]> {
  const list = (await get<ProjectMeta[]>(INDEX_KEY)) ?? [];
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** プロジェクトを読む (無ければ undefined) */
export async function loadProject(id: string): Promise<Project | undefined> {
  return get<Project>(projectKey(id));
}

/** プロジェクトを保存し、一覧も更新する */
export async function saveProject(p: Project): Promise<void> {
  await set(projectKey(p.id), p);
  const list = (await get<ProjectMeta[]>(INDEX_KEY)) ?? [];
  const meta: ProjectMeta = { id: p.id, name: p.name, updatedAt: new Date().toISOString() }; // 一覧用の更新時刻はブラウザ側で持つ (ファイルには書かない)
  const next = [meta, ...list.filter((m) => m.id !== p.id)];
  await set(INDEX_KEY, next);
}

/** プロジェクトを削除する */
export async function deleteProject(id: string): Promise<void> {
  await del(projectKey(id));
  const list = (await get<ProjectMeta[]>(INDEX_KEY)) ?? [];
  await set(INDEX_KEY, list.filter((m) => m.id !== id));
}
