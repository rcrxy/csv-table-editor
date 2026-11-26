const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
   const entries = [
      {
         entryPoints: ["src/extension.ts"],
         platform: "node",
         format: "cjs",
         outfile: "dist/extension.js",
         external: ["vscode"],
      },
      { entryPoints: ["src/webview/main.ts"], platform: "browser", format: "iife", outfile: "dist/webview.js" },
   ];
   const pending = new Set(entries);
   const contexts = [];
   let building = false;
   let watching = false;
   try {
      for (const entry of entries) {
         const problemMatcher = {
            name: "esbuild-problem-matcher",
            setup(build) {
               build.onStart(() => {
                  if (!building) {
                     building = true;
                     console.log("[watch] build started");
                  }
                  pending.add(entry);
               });
               build.onEnd(({ errors }) => {
                  for (const { text, location } of errors) {
                     console.error(`✘ [ERROR] ${text}`);
                     if (location) {
                        console.error(`    ${location.file}:${location.line}:${location.column}:`);
                     }
                  }
                  pending.delete(entry);
                  if (!pending.size) {
                     building = false;
                     console.log("[watch] build finished");
                  }
               });
            },
         };
         contexts.push(
            await esbuild.context({
               ...entry,
               bundle: true,
               minify: production,
               sourcemap: !production,
               sourcesContent: false,
               logLevel: "silent",
               plugins: [problemMatcher],
            }),
         );
      }
      if (watch) {
         await Promise.all(contexts.map((context) => context.watch()));
         watching = true;
      } else {
         await Promise.all(contexts.map((context) => context.rebuild()));
      }
   } finally {
      if (!watching) {
         await Promise.all(contexts.map((context) => context.dispose()));
      }
   }
}

main().catch((error) => {
   console.error(error);
   process.exit(1);
});
