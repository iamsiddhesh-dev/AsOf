import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, loadedEnvKeys } from "../src/env.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-env-"));
  file = path.join(dir, ".env");
});

afterEach(() => {
  delete process.env.ASOF_TEST_ONE;
  delete process.env.ASOF_TEST_TWO;
  delete process.env.ASOF_TEST_THREE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("environment loading", () => {
  it("reads keys and skips comments and blank lines", () => {
    fs.writeFileSync(file, "# comment\n\nASOF_TEST_ONE=alpha\nASOF_TEST_TWO = beta \n");

    const loaded = loadDotEnv(file);

    assert.deepEqual(loaded, ["ASOF_TEST_ONE", "ASOF_TEST_TWO"]);
    assert.equal(process.env.ASOF_TEST_ONE, "alpha");
    assert.equal(process.env.ASOF_TEST_TWO, "beta");
    assert.deepEqual([...loadedEnvKeys()], loaded);
  });

  it("lets a real environment variable win over the file", () => {
    process.env.ASOF_TEST_ONE = "from-shell";
    fs.writeFileSync(file, "ASOF_TEST_ONE=from-file\n");

    const loaded = loadDotEnv(file);

    assert.deepEqual(loaded, []);
    assert.equal(process.env.ASOF_TEST_ONE, "from-shell");
  });

  it("strips one pair of surrounding quotes and keeps empty values", () => {
    fs.writeFileSync(
      file,
      'ASOF_TEST_ONE="quoted value"\nASOF_TEST_TWO=\'single\'\nASOF_TEST_THREE=\n',
    );

    loadDotEnv(file);

    assert.equal(process.env.ASOF_TEST_ONE, "quoted value");
    assert.equal(process.env.ASOF_TEST_TWO, "single");
    assert.equal(process.env.ASOF_TEST_THREE, "");
  });

  it("returns an empty list when the file is absent", () => {
    const loaded = loadDotEnv(path.join(dir, "missing.env"));

    assert.deepEqual(loaded, []);
    assert.deepEqual([...loadedEnvKeys()], []);
  });
});
