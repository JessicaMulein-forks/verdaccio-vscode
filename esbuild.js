const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
    plugins: [
      {
        name: "watch-plugin",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error("Extension build failed with errors");
            } else {
              console.log("Extension build succeeded");
            }
          });
        },
      },
    ],
  });

  if (watch) {
    await extensionCtx.watch();
    console.log("Watching for changes...");
  } else {
    await extensionCtx.rebuild();
    await extensionCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
