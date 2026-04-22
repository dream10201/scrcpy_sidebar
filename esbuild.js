const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const sourcemap = watch;

async function build() {
  const common = {
    bundle: true,
    sourcemap,
    logLevel: "info",
  };

  const ctxs = await Promise.all([
    esbuild.context({
      ...common,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["vscode"],
    }),
    esbuild.context({
      ...common,
      entryPoints: ["src/webview/main.ts"],
      outfile: "dist/webview.js",
      platform: "browser",
      format: "esm",
      target: "es2022",
    }),
  ]);

  if (watch) {
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    return;
  }

  try {
    await Promise.all(ctxs.map((ctx) => ctx.rebuild()));
  } finally {
    await Promise.all(ctxs.map((ctx) => ctx.dispose()));
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
