import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(
  fs.readFileSync(path.join(here, "manifest.json"), "utf8"),
);
export const expectedUnit = JSON.parse(
  fs.readFileSync(path.join(here, "expected-unit-failures.json"), "utf8"),
);
const unitPaths = manifest.changed_files
  .filter((f) => f.path.includes("/__tests__/"))
  .map((f) => f.path.replace("apps/webuiapps/", ""));
const e2ePath = "e2e/file-tool-errors.spec.ts";
export const sha256 = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
export const blobSha = (data) =>
  crypto
    .createHash("sha1")
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const multiset = (items) => items.slice().sort();
const assertEqual = (a, b, message) => assert.deepEqual(a, b, message);
const isSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function verifyBinding(binding, env) {
  assertEqual(binding.repository, "dvd233/OpenRoom", "Unexpected repository");
  assert.match(
    binding.repository_id,
    /^\d+$/,
    "Fork repository ID is not bound",
  );
  assert(isSha(binding.feature_sha), "Feature commit is not bound");
  assertEqual(
    env.GITHUB_REPOSITORY,
    binding.repository,
    "Workflow repository mismatch",
  );
  assertEqual(
    env.GITHUB_REPOSITORY_ID,
    binding.repository_id,
    "Workflow repository ID mismatch",
  );
  assertEqual(
    env.GITHUB_REF_NAME,
    binding.validation_branch,
    "Wrong validation branch",
  );
  assert(
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Unsupported trigger",
  );
}

const nativeFileInventory = [
  "chatHistoryStorage.test.ts",
  "configPersistence.test.ts",
  "diskStorage.test.ts",
  "fileTools.test.ts",
  "imageGenClient.test.ts",
  "llmClient.test.ts",
  "logPlugin.test.ts",
  "logger.test.ts",
  "vibeContainerMock.test.ts",
];
const unitFileInventory = (baseline) =>
  baseline ? ["diskStorage.test.ts", "fileTools.test.ts"] : nativeFileInventory;
export function checkRuntimeReport(report, baseline) {
  assertEqual(
    report.finished,
    true,
    "Native companion reporter did not finish",
  );
  assertEqual(report.unhandledErrorCount, 0, "Native run had unhandled errors");
  assertEqual(
    report.unhandledErrorKinds,
    [],
    "Native run had unhandled errors",
  );
  assertEqual(report.suiteErrors, [], "Native suite/setup/hook failure");
  assertEqual(
    report.testCount,
    baseline ? 60 : 171,
    "Native companion count mismatch",
  );
  assertEqual(
    multiset(report.files),
    multiset(unitFileInventory(baseline)),
    "Native companion file inventory mismatch",
  );
}
export function checkUnitReport(report, baseline) {
  assertEqual(report.numFailedTestSuites, 0, "Native suite/setup failure");
  assertEqual(report.numPendingTestSuites, 0, "Unfinished native suites");
  assertEqual(
    multiset(
      (report.testResults || []).map((suite) => path.basename(suite.name)),
    ),
    multiset(unitFileInventory(baseline)),
    "Wrong native file inventory",
  );
  for (const suite of report.testResults || [])
    assertEqual(suite.message, "", "Native suite setup/hook error");
  const assertions = (report.testResults || []).flatMap((suite) =>
    (suite.assertionResults || []).map((test) => ({
      ...test,
      file: path.basename(suite.name),
    })),
  );
  const expectedTotal = baseline ? 60 : 171;
  assertEqual(assertions.length, expectedTotal, "Wrong collected test count");
  assertEqual(report.numTotalTests, expectedTotal, "Wrong reporter total");
  assertEqual(report.numPendingTests || 0, 0, "Unexpected pending tests");
  assertEqual(report.numTodoTests || 0, 0, "Unexpected todo tests");
  assertEqual(report.numRuntimeErrorTestSuites || 0, 0, "Runtime error suite");
  for (const test of assertions)
    assert(
      ["passed", "failed"].includes(test.status),
      "Skipped or incomplete test",
    );
  const failed = assertions.filter((test) => test.status === "failed");
  assertEqual(failed.length, baseline ? 18 : 0, "Wrong failed test count");
  assertEqual(
    assertions.filter((t) => t.status === "passed").length,
    baseline ? 42 : 171,
    "Wrong passing count",
  );
  assertEqual(
    report.numFailedTests,
    failed.length,
    "Inconsistent failed count",
  );
  assertEqual(
    report.numPassedTests,
    baseline ? 42 : 171,
    "Inconsistent passing count",
  );
  assertEqual(report.success, !baseline, "Inconsistent run success");
  if (baseline) {
    const key = (t) => `${t.file}\0${t.fullName}`;
    assertEqual(
      multiset(failed.map(key)),
      multiset(expectedUnit.expectedFailed.map(key)),
      "Unexpected negative-control failures",
    );
    for (const test of failed) {
      const message = (test.failureMessages || []).join("\n");
      assert(message, "Failure has no assertion evidence");
      assert(
        !/timed out|cannot find|failed to resolve|blocked outbound|socket|launch/i.test(
          message,
        ),
        "Setup/network/timeout failure is not reproduction",
      );
      if (test.file === "fileTools.test.ts") {
        assert(
          /success/.test(message) && /error:/.test(message),
          "Not a false-success assertion",
        );
      } else if (/batch rejects/.test(test.fullName)) {
        assert(
          /pending/.test(message) && /error/.test(message),
          "Not an early-rejection assertion",
        );
      } else {
        assert(
          /promise resolved "undefined" instead of rejecting/.test(message),
          "Not an expected missing-rejection assertion",
        );
      }
    }
  }
  return {
    total: assertions.length,
    passed: expectedTotal - failed.length,
    failed: failed.length,
    negativeControl: baseline,
  };
}

function flattenSpecs(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs || []),
    ...flattenSpecs(suite.suites || []),
  ]);
}
export function checkBrowserReport(report, baseline) {
  assertEqual(
    report.errors || [],
    [],
    "Browser runner reported a global error",
  );
  const specs = flattenSpecs(report.suites || []);
  const expectedNames = [];
  for (const tool of ["file_write", "file_delete"]) {
    for (const result of ["http-500", "network-error", "http-200", "http-204"])
      expectedNames.push(
        `${tool} forwards ${result} to the next model request`,
      );
  }
  assertEqual(
    multiset(specs.map((s) => s.title)),
    multiset(expectedNames),
    "Wrong browser test inventory",
  );
  let passed = 0,
    failed = 0;
  for (const spec of specs) {
    assertEqual(
      path.basename(spec.file),
      "file-tool-errors.spec.ts",
      "Unexpected browser test source",
    );
    assertEqual(spec.tests.length, 1, "Unexpected project/repeat count");
    const test = spec.tests[0];
    assertEqual(test.projectName, "chromium", "Wrong browser project");
    assertEqual(
      test.expectedStatus,
      "passed",
      "Expected-failure annotation is forbidden",
    );
    assertEqual(test.results.length, 1, "Retries or incomplete run");
    const result = test.results[0];
    assertEqual(result.retry, 0, "Unexpected browser retry");
    const expectedFailure =
      baseline && /forwards (http-500|network-error)/.test(spec.title);
    assertEqual(
      result.status,
      expectedFailure ? "failed" : "passed",
      "Wrong browser outcome",
    );
    assertEqual(
      test.status,
      expectedFailure ? "unexpected" : "expected",
      "Inconsistent browser outcome",
    );
    if (expectedFailure) {
      failed++;
      const message = result.error?.message || "";
      assert(
        /expect/.test(message) && /toBe|toMatch/.test(message),
        "Not an assertion failure",
      );
      assert(
        /Received(?: string)?:\s*["']success["']/.test(
          message.replace(/\u001b\[[\d;]*m/g, ""),
        ),
        "Original browser result was not success",
      );
      assertEqual(
        (result.errors || []).length,
        1,
        "Secondary browser/teardown errors are not reproduction",
      );
      const secondary =
        result.errors[0].message?.replace(/\u001b\[[\d;]*m/g, "") || "";
      assert(
        /expect/.test(secondary) &&
          /Received(?: string)?:\s*["']success["']/.test(secondary),
        "Browser error list differs from expected assertion",
      );
      assert(
        !/timed out|target closed|browser.*launch|executable|blocked outbound/i.test(
          message,
        ),
        "Browser setup failure is not reproduction",
      );
    } else {
      passed++;
      assert(
        !result.error && !(result.errors || []).length,
        "Passing browser case has errors",
      );
    }
  }
  assertEqual(
    report.stats?.expected,
    baseline ? 4 : 8,
    "Wrong browser pass count",
  );
  assertEqual(
    report.stats?.unexpected,
    baseline ? 4 : 0,
    "Wrong browser fail count",
  );
  assertEqual(report.stats?.skipped, 0, "Skipped browser tests");
  assertEqual(report.stats?.flaky, 0, "Flaky browser tests");
  return { total: 8, passed, failed, negativeControl: baseline };
}

export function checkCoverage(summary) {
  const wanted = ["diskStorage.ts", "fileTools.ts"];
  const results = {};
  for (const file of wanted) {
    const matching = Object.entries(summary).filter(([key]) =>
      key.endsWith(`/src/lib/${file}`),
    );
    assertEqual(matching.length, 1, `Missing/duplicate coverage for ${file}`);
    const metrics = matching[0][1];
    for (const name of ["lines", "branches", "functions", "statements"]) {
      assert(
        typeof metrics[name]?.pct === "number" && metrics[name].pct > 90,
        `${file} ${name} must exceed 90%`,
      );
      assert(
        metrics[name].total > 0,
        `${file} ${name} denominator must be positive`,
      );
    }
    results[file] = metrics;
  }
  return results;
}

function git(repo, ...args) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", repo, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}
export function verifyCheckout(
  repo,
  baseline,
  sourceManifest = manifest,
  requireRegressionTests = true,
) {
  const expectedCommit = baseline
    ? sourceManifest.base_head
    : sourceManifest.binding.feature_sha;
  assertEqual(
    git(repo, "rev-parse", "HEAD"),
    expectedCommit,
    "Unexpected source commit",
  );
  assertEqual(
    git(repo, "rev-parse", "HEAD^{tree}"),
    baseline ? sourceManifest.base_tree : sourceManifest.candidate_tree,
    "Unexpected source tree",
  );
  git(repo, "diff", "--no-ext-diff", "--exit-code", "HEAD", "--");
  if (!baseline)
    assertEqual(
      git(repo, "show", "-s", "--format=%P", "HEAD"),
      sourceManifest.base_head,
      "Feature must have exactly the fixed base as its sole parent",
    );
  for (const file of sourceManifest.changed_files) {
    if (baseline && !file.base_blob_sha && !requireRegressionTests) continue;
    const destination = path.join(repo, file.path);
    assert(
      fs.lstatSync(destination).isFile(),
      `Source is not a regular file: ${file.path}`,
    );
    const bytes = fs.readFileSync(destination);
    assertEqual(
      blobSha(bytes),
      baseline && file.base_blob_sha ? file.base_blob_sha : file.git_blob_sha,
      `Source blob mismatch: ${file.path}`,
    );
    if (!baseline || !file.base_blob_sha)
      assertEqual(
        sha256(bytes),
        file.sha256,
        `Source SHA256 mismatch: ${file.path}`,
      );
  }
  return {
    commit: expectedCommit,
    tree: baseline ? sourceManifest.base_tree : sourceManifest.candidate_tree,
    baseline,
  };
}

export function browserConfigText(repo, outputDir, reportFile) {
  const config = JSON.stringify(path.join(repo, "playwright.config.ts"));
  return `import upstream from ${config};\nexport default {\n  ...upstream,\n  testDir: ${JSON.stringify(path.join(repo, "e2e"))},\n  testMatch: 'file-tool-errors.spec.ts',\n  retries: 0,\n  workers: 1,\n  reporter: [['list'], ['json', { outputFile: ${JSON.stringify(reportFile)} }]],\n  outputDir: ${JSON.stringify(outputDir)},\n  use: { ...upstream.use, baseURL: 'http://127.0.0.1:3000', launchOptions: { ...upstream.use?.launchOptions, chromiumSandbox: true } },\n  webServer: Array.isArray(upstream.webServer) ? upstream.webServer.map(server => ({ ...server, command: 'pnpm --filter @openroom/webuiapps dev --host 127.0.0.1 --port 3000 --strictPort', url: 'http://127.0.0.1:3000', cwd: ${JSON.stringify(repo)}, reuseExistingServer: false })) : { ...upstream.webServer, command: 'pnpm --filter @openroom/webuiapps dev --host 127.0.0.1 --port 3000 --strictPort', url: 'http://127.0.0.1:3000', cwd: ${JSON.stringify(repo)}, reuseExistingServer: false },\n};\n`;
}

function paths() {
  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const report = process.env.VALIDATION_REPORT_DIR;
  assert(
    report && path.isAbsolute(report),
    "An absolute report directory is required",
  );
  const temporary = process.env.RUNNER_TEMP;
  assert(temporary && path.isAbsolute(temporary), "RUNNER_TEMP is required");
  fs.mkdirSync(report, { recursive: true });
  return {
    candidate: path.join(workspace, "candidate"),
    baseline: path.join(workspace, "baseline"),
    report,
    home: path.join(temporary, "openroom-file-tool-runtime-home"),
    config: path.join(temporary, "openroom-file-tool-configs"),
    browserOutput: path.join(temporary, "openroom-file-tool-browser-output"),
  };
}
function runtimeEnv(p) {
  assert(fs.existsSync(p.home), "Runtime home not prepared");
  return {
    ...process.env,
    HOME: p.home,
    CI: "true",
    HUSKY: "0",
    DO_NOT_TRACK: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--require=${path.join(here, "runtime-egress.cjs")}`,
    VALIDATION_EGRESS_LOG: path.join(p.report, "egress-attempts.jsonl"),
    VALIDATION_LISTENER_LOG: path.join(p.report, "listener-bindings.jsonl"),
  };
}
function noEgress(p) {
  const log = path.join(p.report, "egress-attempts.jsonl");
  assert(
    !fs.existsSync(log) || fs.statSync(log).size === 0,
    "Unexpected outbound access was blocked; this is not passing validation",
  );
}
async function command(p, name, argv, cwd, expectedExit = 0, extraEnv = {}) {
  const journal = path.join(p.report, `${name}.result.json`);
  writeJson(journal, {
    name,
    argv,
    state: "RUNNING",
    sourceCommit: manifest.binding.feature_sha,
    startedAt: new Date().toISOString(),
  });
  const log = fs.openSync(path.join(p.report, `${name}.log`), "w");
  let code, signal;
  try {
    ({ code, signal } = await new Promise((resolve, reject) => {
      const child = spawn("pnpm", argv, {
        cwd,
        env: { ...runtimeEnv(p), VALIDATION_STAGE: name, ...extraEnv },
        shell: false,
        stdio: ["ignore", log, log],
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    }));
  } finally {
    fs.closeSync(log);
  }
  const result = {
    name,
    argv,
    sourceCommit: manifest.binding.feature_sha,
    exitCode: code,
    signal,
    expectedExit,
    state: "EXECUTED",
    finishedAt: new Date().toISOString(),
  };
  writeJson(journal, result);
  assertEqual(signal, null, `${name} terminated by signal`);
  assertEqual(
    code,
    expectedExit,
    `${name} has an unexpected exit code; see its log`,
  );
  noEgress(p);
  return result;
}
function pass(p, result, evidence) {
  writeJson(path.join(p.report, `${result.name}.result.json`), {
    ...result,
    state: "PASS",
    evidence,
  });
  console.log(`${result.name}: PASS`);
}
function unitArgs(report, baseline, coverage) {
  const args = [
    "--filter",
    "@openroom/webuiapps",
    coverage ? "test:coverage" : "test",
  ];
  if (baseline) args.push(...unitPaths);
  args.push(
    "--pool=threads",
    "--minWorkers=1",
    "--maxWorkers=1",
    "--reporter=json",
    `--reporter=${path.join(here, "unit-runtime-reporter.mjs")}`,
    `--outputFile=${report}`,
  );
  if (coverage)
    args.push(
      "--coverage.include=src/lib/diskStorage.ts",
      "--coverage.include=src/lib/fileTools.ts",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=text",
      "--coverage.reporter=lcov",
      "--coverage.thresholds.lines=90",
      "--coverage.thresholds.functions=90",
      "--coverage.thresholds.branches=90",
      "--coverage.thresholds.statements=90",
    );
  return args;
}

async function main(action) {
  if (action === "binding") {
    verifyBinding(manifest.binding, process.env);
    console.log(
      `feature_sha=${manifest.binding.feature_sha}\nbase_sha=${manifest.base_head}`,
    );
    return;
  }
  verifyBinding(manifest.binding, process.env);
  const p = paths();
  if (action === "verify") {
    writeJson(path.join(p.report, "binding-and-source.json"), {
      manifest,
      candidate: verifyCheckout(p.candidate, false),
      baseline: verifyCheckout(p.baseline, true, manifest, false),
      runtime: { node: process.version, platform: process.platform },
    });
    return;
  }
  if (action === "prepare") {
    verifyCheckout(p.candidate, false);
    verifyCheckout(p.baseline, true, manifest, false);
    assert(
      !fs.existsSync(p.home),
      "Runtime home already exists; do not adopt preexisting data",
    );
    fs.mkdirSync(p.home, { recursive: true });
    fs.mkdirSync(p.config, { recursive: true });
    for (const file of manifest.changed_files.filter(
      (f) => f.base_blob_sha === null,
    )) {
      const target = path.join(p.baseline, file.path);
      assert(!fs.existsSync(target), "Baseline test already exists");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(p.candidate, file.path), target);
      assertEqual(
        sha256(fs.readFileSync(target)),
        file.sha256,
        "Copied baseline test mismatch",
      );
    }
    for (const workspace of [
      ".",
      "apps/webuiapps",
      "packages/vibe-container",
    ]) {
      const from = path.join(p.candidate, workspace, "node_modules");
      const to = path.join(p.baseline, workspace, "node_modules");
      if (!fs.existsSync(from)) continue;
      assert(!fs.existsSync(to), "Baseline dependencies already exist");
      fs.symlinkSync(from, to, "dir");
    }
    verifyCheckout(p.baseline, true);
    const resolution = await command(
      p,
      "baseline-resolution",
      [
        "--filter",
        "@openroom/webuiapps",
        "exec",
        "node",
        "-e",
        "for (const name of ['vitest', 'vite', 'react', 'i18next', 'jszip']) console.log(name + ': ' + require.resolve(name))",
      ],
      p.baseline,
    );
    pass(p, resolution, { packageEntriesResolved: true });
    const version = await command(
      p,
      "baseline-vitest-version",
      ["--filter", "@openroom/webuiapps", "exec", "vitest", "--version"],
      p.baseline,
    );
    assert(
      /vitest\/1\.6\.1/.test(
        fs.readFileSync(
          path.join(p.report, "baseline-vitest-version.log"),
          "utf8",
        ),
      ),
      "Unexpected baseline Vitest version",
    );
    pass(p, version, { version: "1.6.1" });
    return;
  }
  if (
    ["candidate-unit", "candidate-coverage", "baseline-unit"].includes(action)
  ) {
    const baseline = action.startsWith("baseline");
    const coverage = action.endsWith("coverage");
    const repo = baseline ? p.baseline : p.candidate;
    verifyCheckout(repo, baseline);
    const json = path.join(p.report, `${action}.json`);
    const runtimeReport = path.join(p.report, `${action}-runtime.json`);
    const result = await command(
      p,
      action,
      unitArgs(json, baseline, coverage),
      repo,
      baseline ? 1 : 0,
      { VALIDATION_VITEST_RUNTIME_REPORT: runtimeReport },
    );
    const evidence = checkUnitReport(readJson(json), baseline);
    checkRuntimeReport(readJson(runtimeReport), baseline);
    if (coverage) {
      const coveragePath = path.join(
        repo,
        "apps/webuiapps/coverage/coverage-summary.json",
      );
      evidence.coverage = checkCoverage(readJson(coveragePath));
      fs.copyFileSync(
        coveragePath,
        path.join(p.report, "coverage-summary.json"),
      );
      fs.copyFileSync(
        path.join(repo, "apps/webuiapps/coverage/lcov.info"),
        path.join(p.report, "lcov.info"),
      );
    }
    verifyCheckout(repo, baseline);
    pass(p, result, evidence);
    return;
  }
  if (action === "lint" || action === "build") {
    verifyCheckout(p.candidate, false);
    const result = await command(
      p,
      action,
      action === "lint" ? ["run", "lint"] : ["build"],
      p.candidate,
    );
    verifyCheckout(p.candidate, false);
    pass(p, result, { cleanSource: true });
    return;
  }
  if (action === "candidate-e2e" || action === "baseline-e2e") {
    const baseline = action.startsWith("baseline");
    const repo = baseline ? p.baseline : p.candidate;
    verifyCheckout(repo, baseline);
    const config = path.join(p.config, `${action}.config.ts`);
    const report = path.join(p.report, `${action}.json`);
    fs.writeFileSync(
      config,
      browserConfigText(repo, path.join(p.browserOutput, action), report),
    );
    const result = await command(
      p,
      action,
      [
        "exec",
        "playwright",
        "test",
        "--config",
        config,
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      repo,
      baseline ? 1 : 0,
    );
    const evidence = checkBrowserReport(readJson(report), baseline);
    verifyCheckout(repo, baseline);
    pass(p, result, { ...evidence, chromiumSandbox: true, scope: e2ePath });
    return;
  }
  if (action === "summarize") {
    const required = [
      "baseline-resolution",
      "baseline-vitest-version",
      "candidate-unit",
      "candidate-coverage",
      "lint",
      "build",
      "baseline-unit",
      "candidate-e2e",
      "baseline-e2e",
    ];
    const results = required.map((name) =>
      readJson(path.join(p.report, `${name}.result.json`)),
    );
    for (const result of results) {
      assertEqual(result.state, "PASS", `Incomplete stage: ${result.name}`);
      assertEqual(
        result.sourceCommit,
        manifest.binding.feature_sha,
        "Mixed source evidence",
      );
    }
    noEgress(p);
    const bindings = fs
      .readFileSync(path.join(p.report, "listener-bindings.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert(bindings.length > 0, "No actual listener binding evidence");
    for (const address of bindings)
      assert(
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address.address),
        "A runtime listener was not loopback-bound",
      );
    for (const stage of [
      "candidate-unit",
      "baseline-unit",
      "candidate-e2e",
      "baseline-e2e",
    ])
      assert(
        bindings.some((entry) => entry.stage === stage),
        `Missing actual binding evidence for ${stage}`,
      );
    const source = {
      candidate: verifyCheckout(p.candidate, false),
      baseline: verifyCheckout(p.baseline, true),
    };
    writeJson(path.join(p.report, "summary.json"), {
      state: "PASS",
      source,
      results,
      listenerBindings: bindings,
      runtimeDeltas: [
        "Native Node listeners with unspecified/wildcard host are narrowed to127.0.0.1; actual addresses logged.",
        "Browser config inherits upstream and enables Chromium sandbox, binds dev server127.0.0.1 and focuses eight tests.",
      ],
      limitation:
        "Only the eight impacted file-tool E2E cases were run, not the pre-existing app.spec.ts suite.",
    });
    console.log("All required source-bound validation stages passed.");
    return;
  }
  throw new Error(`Unknown validation action: ${action}`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv[2]).catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
