import type { ItemKeyGroup, KeyFileInfo } from "@obzt/common";
import { getItemKeyGroupID } from "@obzt/common";
import { Service } from "@ophidian/core";
import assertNever from "assert-never";
import type {
  BlockCache,
  CachedMetadata,
  MetadataCache,
  TAbstractFile,
  Vault,
} from "obsidian";
import { TFile, TFolder } from "obsidian";
import log from "@log";

import ZoteroPlugin from "../zt-main.js";
import { NoteIndexSettings } from "./settings.js";
import getZoteroKeyFileMap, {
  getItemKeyFromFrontmatter,
} from "./ztkey-file-map.js";

export { getItemKeyGroupID };
export default class NoteIndex extends Service {
  get meta(): MetadataCache {
    return this.plugin.app.metadataCache;
  }
  get vault(): Vault {
    return this.plugin.app.vault;
  }
  get template() {
    return this.plugin.settings.template;
  }
  settings = this.use(NoteIndexSettings);

  keyFileMap: Map<string, KeyFileInfo> = new Map();

  addToIndex(info: KeyFileInfo): void {
    this.keyFileMap.set(info.key, info);
  }
  deleteFromIndex(k: string, use: "itemKey" | "file"): boolean {
    let key: string | undefined, file: string | undefined;
    switch (use) {
      case "itemKey":
        key = k;
        file = this.keyFileMap.get(key)?.file;
        break;
      case "file":
        file = k;
        key = [...this.keyFileMap.values()].find((v) => v.file === file)?.key;
        break;
      default:
        assertNever(use);
    }
    if (!key || !file) return false;
    this.keyFileMap.delete(key);
    return true;
  }

  getNoteFromItem(item: ItemKeyGroup): KeyFileInfo | undefined {
    log.debug("getNoteFromKey: ", item, getItemKeyGroupID(item, true));
    return this.keyFileMap.get(getItemKeyGroupID(item, true));
  }
  getBlockInfoFromItem(item: ItemKeyGroup): BlockCache | null {
    const note = this.getNoteFromItem(item);
    if (!note || !note.blockId) return null;
    const cache = this.meta.getCache(note.file);
    if (!cache) return null;
    const block = cache?.blocks?.[note.blockId.toLowerCase()];
    return block || null;
  }

  // buildFilemapWorker: PromiseWorker<Input, Output>;

  plugin = this.use(ZoteroPlugin);
  onload(): void {
    // plugin.register(() => this.buildFilemapWorker.terminate());
    [
      this.meta.on("changed", this.onMetaChanged.bind(this)),
      this.meta.on("finished", this.onMetaBuilt.bind(this)),
      // this.vault.on("create") // also fired on meta.changed
      this.vault.on("rename", this.onFileMoved.bind(this)),
      this.vault.on("delete", this.onFileMoved.bind(this)),
    ].forEach(this.registerEvent.bind(this));
    if (this.meta.initialized) this.onMetaBuilt();
  }

  isLiteratureNote(file: string): boolean;
  isLiteratureNote(file: TAbstractFile): file is TFile;
  isLiteratureNote(file: TAbstractFile | string): boolean {
    const path = getFilePath(file),
      itemKey = getItemKeyFromFrontmatter(this.meta.getCache(path));
    if (!itemKey) return false;
    return this.keyFileMap.has(itemKey);
  }

  /** check if file belongs to literature note folder */
  #isLiteratureNote(file: string): boolean;
  #isLiteratureNote(file: TAbstractFile): file is TFile;
  #isLiteratureNote(file: TAbstractFile | string): boolean {
    if (typeof file === "string") {
      return file.endsWith(".md") && file.startsWith(this.settings.joinPath);
    } else
      return (
        file instanceof TFile &&
        file.extension === "md" &&
        file.path.startsWith(this.settings.joinPath)
      );
  }

  onMetaBuilt() {
    const folder = this.vault.getAbstractFileByPath(
      this.settings.literatureNoteFolder,
    );
    if (folder && folder instanceof TFolder)
      for (const file of getAllMarkdownIn(folder)) {
        this.addFileRecord(file);
      }
  }
  onMetaChanged(file: TFile, _data: string, cache: CachedMetadata) {
    if (!this.#isLiteratureNote(file)) return;
    this.updateFileRecord(file, cache);
  }
  onFileMoved(file: TAbstractFile, oldPath?: string) {
    if (!(file instanceof TFile && file.extension === "md")) return;
    const isCurrNote = this.#isLiteratureNote(file.path);
    if (oldPath) {
      // file renamed
      const isOldNote = this.#isLiteratureNote(oldPath);
      if (!isCurrNote && !isOldNote) {
        return; // not inside note folder
      } else if (isCurrNote && isOldNote) {
        this.renameFileRecord(file, oldPath);
      } else if (isCurrNote) {
        this.addFileRecord(file);
      } else {
        this.removeFileRecord(oldPath);
      }
    } else {
      // file deleted
      if (!isCurrNote) return;
      this.removeFileRecord(file);
    }
  }

  addFileRecord(file: TFile | string): void {
    const path = getFilePath(file),
      cache = this.meta.getCache(path);
    if (cache) this.updateFileRecord(path, cache);
  }
  removeFileRecord(file: TFile | string): void {
    const path = getFilePath(file);
    this.deleteFromIndex(path, "file");
  }
  renameFileRecord(file: TFile | string, oldPath: string): void {
    const path = getFilePath(file);
    const info = [...this.keyFileMap.values()].find(
      ({ file }) => file === oldPath,
    );
    if (info) {
      info.file = path;
    }
  }
  updateFileRecord(file: TFile | string, cache: CachedMetadata): void {
    const path = getFilePath(file);
    for (const info of getZoteroKeyFileMap(path, cache)) {
      this.addToIndex(info);
    }
  }

  reload(): void {
    this.keyFileMap.clear();
    this.onMetaBuilt();
  }

  // trigger(name: string, ...data: any[]): void {}
}

function* getAllMarkdownIn(folder: TFolder): IterableIterator<TFile> {
  for (const af of folder.children) {
    if (af instanceof TFolder) {
      yield* getAllMarkdownIn(af);
    } else if (af instanceof TFile && af.extension === "md") {
      yield af;
    }
  }
}

const getFilePath = (file: TAbstractFile | string): string =>
  typeof file === "string" ? file : file.path;