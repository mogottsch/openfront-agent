import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(process.env.OPENFRONT_DIR || "../OpenFrontIO");
const runner = resolve(repo, "src/client/ClientGameRunner.ts");
const bridge = resolve(repo, "src/client/WildernessAgentBridge.ts");
const source = await readFile(
  new URL("../integration/WildernessAgentBridge.ts", import.meta.url),
  "utf8",
);
const patches = [
  [
    'import { WebGLFrameBuilder } from "./WebGLFrameBuilder";',
    'import { WebGLFrameBuilder } from "./WebGLFrameBuilder";\nimport { attachWildernessAgent } from "./WildernessAgentBridge";',
  ],
  [
    "export class ClientGameRunner {",
    "export class ClientGameRunner {\n  private detachWildernessAgent: (() => void) | null = null;",
  ],
  [
    "    this.renderer.initialize();\n    this.input.initialize();",
    "    this.renderer.initialize();\n    this.input.initialize();\n    this.detachWildernessAgent = attachWildernessAgent(this.gameView, this.eventBus);",
  ],
  [
    "  public stop() {\n    this.soundManager.dispose();",
    "  public stop() {\n    this.detachWildernessAgent?.();\n    this.detachWildernessAgent = null;\n    this.soundManager.dispose();",
  ],
];
const remove = process.argv.includes("--remove");
let text = await readFile(runner, "utf8");
for (const [before, after] of patches) {
  const from = remove ? after : before;
  const to = remove ? before : after;
  if (!remove && text.includes(after)) continue;
  if (remove && !text.includes(after)) continue;
  if (text.split(from).length !== 2)
    throw new Error(`Upstream changed; expected a unique anchor: ${from}`);
  text = text.replace(from, to);
}
try {
  const existing = await readFile(bridge, "utf8");
  if (
    !existing.startsWith(
      "// Local experimental bridge owned by ../openfront-agent;",
    )
  )
    throw new Error("Refusing to overwrite an unrecognized bridge");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (remove)
  await unlink(bridge).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
else await writeFile(bridge, source);
await writeFile(runner, text);
console.log(`${remove ? "Removed" : "Installed"} local-solo bridge in ${repo}`);
