import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { Diagnostic } from "#diagnostic";
import { Environment } from "#environment";
import { EventEmitter } from "#events";
import { Path } from "#path";
import { Lock } from "./Lock.js";
import { Version } from "./Version.js";

export class CompilerModuleWorker {
  #cachePath: string;
  #onDiagnostic: (diagnostic: Diagnostic) => void;
  #readyFileName = "__ready__";
  #timeout = Environment.timeout * 1000;

  constructor(cachePath: string, onDiagnostic: (diagnostic: Diagnostic) => void) {
    this.#cachePath = cachePath;
    this.#onDiagnostic = onDiagnostic;
  }

  async ensure(compilerVersion: string, signal?: AbortSignal): Promise<string | undefined> {
    const installationPath = Path.join(this.#cachePath, compilerVersion);
    const readyFilePath = Path.join(installationPath, this.#readyFileName);
    const tsserverFilePath = Path.join(installationPath, "node_modules", "typescript", "lib", "tsserverlibrary.js");
    // since TypeScript 5.3 the 'typescript.js' file must be patched, reference: https://github.com/microsoft/TypeScript/wiki/API-Breaking-Changes#typescript-53
    const typescriptFilePath = Path.join(installationPath, "node_modules", "typescript", "lib", "typescript.js");

    if (
      await Lock.isLocked(installationPath, {
        onDiagnostic: (text) => {
          this.#onDiagnostic(Diagnostic.error([`Failed to install 'typescript@${compilerVersion}'.`, text]));
        },
        signal,
        timeout: this.#timeout,
      })
    ) {
      return;
    }

    if (!existsSync(readyFilePath)) {
      EventEmitter.dispatch(["store:info", { compilerVersion, installationPath }]);

      try {
        await fs.mkdir(installationPath, { recursive: true });

        const lock = new Lock(installationPath);

        await fs.writeFile(Path.join(installationPath, "package.json"), this.#getPackageJson(compilerVersion));
        await this.#installPackage(installationPath, signal);

        await fs.writeFile(readyFilePath, "");

        lock.release();
      } catch (error) {
        this.#onDiagnostic(Diagnostic.fromError(`Failed to install 'typescript@${compilerVersion}'.`, error));
      }
    }

    if (Version.satisfies(compilerVersion, "5.3")) {
      return typescriptFilePath;
    }

    return tsserverFilePath;
  }

  #getPackageJson(version: string) {
    const packageJson = {
      /* eslint-disable sort-keys */
      name: "@tstyche/typescript",
      version,
      description: "Do not change. This package was generated by TSTyche",
      private: true,
      license: "MIT",
      dependencies: {
        typescript: version,
      },
      /* eslint-enable sort-keys */
    };

    return JSON.stringify(packageJson, null, 2);
  }

  async #installPackage(cwd: string, signal?: AbortSignal) {
    const args = ["install", "--ignore-scripts", "--no-bin-links", "--no-package-lock"];

    return new Promise<void>((resolve, reject) => {
      const spawnedNpm = spawn("npm", args, {
        cwd,
        shell: true,
        signal,
        stdio: "ignore",
        timeout: this.#timeout,
      });

      spawnedNpm.on("error", (error) => {
        reject(error);
      });

      spawnedNpm.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
        }

        if (signal != null) {
          reject(new Error(`Setup timeout of ${this.#timeout / 1000}s was exceeded.`));
        }

        reject(new Error(`Process exited with code ${String(code)}.`));
      });
    });
  }
}
