#!/usr/bin/env node
// PreToolUse hook for the Unpaged server's comment_reply: allows the call
// when it posts exactly the "On it…" reply the listener mod sends the moment
// an @agent comment arrives. Prints nothing for any other reply, which then
// goes through the user's own permission rules.
import { ackHookOutput } from "./listen-core.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

let input = null;
try {
  input = JSON.parse(await readStdin());
} catch {
  input = null;
}
const output = ackHookOutput(input);
if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
