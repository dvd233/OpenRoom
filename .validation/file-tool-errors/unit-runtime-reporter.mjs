import fs from "node:fs";
import path from "node:path";

// Vitest 1.6.1's JSON reporter omits global unhandled errors. Keep an
// independent native reporter record so an expected baseline exit1 cannot hide them.
export default class RuntimeGuardReporter {
  onInit(ctx) {
    this.ctx = ctx;
    this.output = process.env.VALIDATION_VITEST_RUNTIME_REPORT;
    if (!this.output) throw new Error("Missing runtime reporter output path");
    fs.writeFileSync(this.output, JSON.stringify({ finished: false }) + "\n");
  }
  onFinished(files, errors) {
    files ??= this.ctx.state.getFiles();
    errors ??= this.ctx.state.getUnhandledErrors();
    if (!Array.isArray(files) || !Array.isArray(errors))
      throw new Error("Incomplete Vitest runtime state");
    const suiteErrors = [];
    let testCount = 0;
    const visit = (task) => {
      if (task.type === "test") testCount++;
      else if (task.result?.errors?.length)
        suiteErrors.push({ name: task.name, count: task.result.errors.length });
      for (const child of task.tasks || []) visit(child);
    };
    for (const file of files) visit(file);
    if (errors.length || suiteErrors.length) process.exitCode = 1;
    fs.writeFileSync(
      this.output,
      JSON.stringify(
        {
          finished: true,
          files: files.map((file) => path.basename(file.filepath)),
          testCount,
          suiteErrors,
          unhandledErrorCount: errors.length,
          unhandledErrorKinds: errors.map((error) =>
            String(error?.name || error?.type || typeof error),
          ),
        },
        null,
        2,
      ) + "\n",
    );
  }
}
