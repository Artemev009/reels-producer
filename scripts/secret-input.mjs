import process from "node:process";
import { createInterface } from "node:readline/promises";

export async function readSecret(label) {
  process.stdout.write(label);

  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const input = createInterface({ input: process.stdin });
    try {
      return (await input.question("")).trim();
    } finally {
      input.close();
    }
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Ввод отменён"));
        if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };

    process.stdin.on("data", onData);
  });
}
