import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type ts from "typescript/lib/tsserverlibrary.js";
import { Diagnostic } from "#diagnostic";
import { Environment } from "#environment";
import { EventEmitter } from "#events";
import { CompilerModuleWorker } from "./CompilerModuleWorker.js";
import { type Manifest, ManifestWorker } from "./ManifestWorker.js";

export class StoreService {
  #cachePath: string;
  #compilerModuleWorker: CompilerModuleWorker;
  #manifest: Manifest | undefined;
  #manifestWorker: ManifestWorker;
  #nodeRequire = createRequire(import.meta.url);

  constructor() {
    this.#cachePath = Environment.storePath;

    this.#compilerModuleWorker = new CompilerModuleWorker(this.#cachePath);
    this.#manifestWorker = new ManifestWorker(this.#cachePath, async () => this.prune());
  }

  get supportedTags(): Array<string> {
    if (!this.#manifest) {
      this.#onDiagnostic(Diagnostic.error("Store manifest is not open. Call 'StoreService.open()' first."));

      return [];
    }

    return [...Object.keys(this.#manifest.resolutions), ...this.#manifest.versions].sort();
  }

  async install(tag: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.#manifest) {
      this.#onDiagnostic(Diagnostic.error("Store manifest is not open. Call 'StoreService.open()' first."));

      return;
    }

    const version = this.resolveTag(tag);

    if (version == null) {
      this.#onDiagnostic(Diagnostic.error(`Cannot add the 'typescript' package for the '${tag}' tag.`));

      return;
    }

    let modulePath: string | undefined;

    try {
      modulePath = await this.#compilerModuleWorker.ensure(version, signal);
    } catch (error) {
      this.#onDiagnostic(Diagnostic.fromError(`Failed to install 'typescript@${version}'.`, error));
    }

    if (modulePath != null) {
      if (!("lastUsed" in this.#manifest)) {
        this.#manifest.lastUsed = {};
      }

      this.#manifest.lastUsed[version] = Date.now();

      // TODO
      // await this.#manifestWorker.persist(this.#manifest);
    }

    return modulePath;
  }

  async load(tag: string, signal?: AbortSignal): Promise<typeof ts | undefined> {
    let modulePath: string | undefined;

    if (tag === "local") {
      try {
        modulePath = this.#nodeRequire.resolve("typescript/lib/tsserverlibrary.js");
      } catch {
        // TypeScript is not installed locally, let's load "latest" from the store
        tag = "latest";
      }
    }

    if (modulePath == null) {
      modulePath = await this.install(tag, signal);
    }

    if (modulePath != null) {
      return this.#nodeRequire(modulePath) as typeof ts;
    }

    return;
  }

  #onDiagnostic(diagnostic: Diagnostic) {
    EventEmitter.dispatch(["store:error", { diagnostics: [diagnostic] }]);
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.#manifest) {
      return;
    }

    this.#manifest = await this.#manifestWorker.open(signal);

    // TODO versions not used for 60 days should be garbage collected
  }

  async prune(): Promise<void> {
    await fs.rm(this.#cachePath, { force: true, recursive: true });
  }

  resolveTag(tag: string): string | undefined {
    if (!this.#manifest) {
      this.#onDiagnostic(Diagnostic.error("Store manifest is not open. Call 'StoreService.open()' first."));

      return;
    }

    if (this.#manifest.versions.includes(tag)) {
      return tag;
    }

    const version = this.#manifest.resolutions[tag];

    if (
      this.#manifestWorker.isOutdated(this.#manifest, /* ageTolerance */ 60 /* one minute */) &&
      Object.keys(this.#manifest.resolutions).slice(-5).includes(tag)
    ) {
      this.#onDiagnostic(
        Diagnostic.warning([
          "Failed to update metadata of the 'typescript' package from the registry.",
          `The resolution of the '${tag}' tag may be outdated.`,
        ]),
      );
    }

    return version;
  }

  async update(signal?: AbortSignal): Promise<void> {
    if (!this.#manifest) {
      this.#onDiagnostic(Diagnostic.error("Store manifest is not open. Call 'StoreService.open()' first."));

      return;
    }

    await this.#manifestWorker.update(this.#manifest, signal);
  }

  validateTag(tag: string): boolean {
    if (!this.#manifest) {
      this.#onDiagnostic(Diagnostic.error("Store manifest is not open. Call 'StoreService.open()' first."));

      return false;
    }

    if (this.#manifest.versions.includes(tag) || tag in this.#manifest.resolutions) {
      return true;
    }

    if (
      this.#manifest.resolutions["latest"] != null &&
      tag.startsWith(this.#manifest.resolutions["latest"].slice(0, 3))
    ) {
      this.#onDiagnostic(
        Diagnostic.warning([
          "Failed to update metadata of the 'typescript' package from the registry.",
          `The resolution of the '${tag}' tag may be outdated.`,
        ]),
      );
    }

    return false;
  }
}
