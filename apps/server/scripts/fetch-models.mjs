#!/usr/bin/env node
// Downloads the built-in embedding model files (src/embeddings-local/models.json) into the
// models directory, pinned to an exact Hugging Face revision and verified by SHA-256.
// Idempotent: files already present with the right hash are skipped. Plain Node, no dependencies.
//
//   pnpm --filter @orlok/server models:fetch     # into apps/server/models
//   ORLOK_MODELS_DIR=/data/models node scripts/fetch-models.mjs
//
// Docker: a build stage runs `pnpm --filter @orlok/server models:fetch` (network needed only
// there) and the runtime image copies apps/server/models (~135 MB) to the same path, or anywhere
// with ORLOK_MODELS_DIR pointing at it. The running server never downloads anything.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const serverDirectory = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(serverDirectory, "src/embeddings-local/models.json");
const modelsDirectory = path.resolve(
  process.env.ORLOK_MODELS_DIR?.trim() || path.join(serverDirectory, "models"),
);

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function isVerified(file, expected) {
  if (!existsSync(file)) {
    return false;
  }
  if ((await stat(file)).size !== expected.size) {
    return false;
  }
  return (await sha256(file)) === expected.sha256;
}

async function download(url, target, expected) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  const partial = `${target}.partial`;
  const hash = createHash("sha256");
  let size = 0;
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    hash.update(chunk);
    size += chunk.length;
  });
  try {
    await pipeline(source, createWriteStream(partial));
    const digest = hash.digest("hex");
    if (size !== expected.size || digest !== expected.sha256) {
      throw new Error(
        `Checksum mismatch for ${url}: got ${size} bytes sha256 ${digest}, ` +
          `expected ${expected.size} bytes sha256 ${expected.sha256}`,
      );
    }
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let failures = 0;
  for (const [name, model] of Object.entries(manifest)) {
    if (!/^[0-9a-f]{40}$/.test(model.revision)) {
      throw new Error(`${name}: revision must be a commit hash, got "${model.revision}"`);
    }
    const directory = path.join(modelsDirectory, name);
    for (const file of model.files) {
      const target = path.join(directory, file.path);
      const label = `${name}/${file.path}`;
      if (await isVerified(target, file)) {
        console.log(`ok       ${label}`);
        continue;
      }
      const url = `${model.source}/resolve/${model.revision}/${file.path}`;
      console.log(`fetch    ${label} (${(file.size / 1e6).toFixed(1)} MB)`);
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await download(url, target, file);
        console.log(`verified ${label}`);
      } catch (error) {
        failures++;
        console.error(`error    ${label}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  if (failures > 0) {
    console.error(`${failures} model file(s) could not be fetched into ${modelsDirectory}`);
    process.exit(1);
  }
  console.log(`Models ready in ${modelsDirectory}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
