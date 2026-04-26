import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { JINN_HOME } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

function buildRyokoArgs(args: string[]): string[] {
  const instance = process.env.RYOKO_INSTANCE;
  return instance ? ["-i", instance, ...args] : args;
}

export async function runUpdate(opts: { noMigrate?: boolean }): Promise<void> {
  const currentVersion = getPackageVersion();

  console.log(`\n${DIM}Current CLI version:${RESET} ${currentVersion}`);
  console.log(`${YELLOW}Updating OpenRyoko CLI from npm...${RESET}\n`);

  try {
    run("npm", ["install", "-g", "openryoko@latest"]);
  } catch {
    console.error(`\n${RED}Update failed.${RESET}`);
    console.error(`Try running manually: ${DIM}npm install -g openryoko@latest${RESET}\n`);
    process.exit(1);
  }

  if (!opts.noMigrate && fs.existsSync(JINN_HOME)) {
    console.log(`\n${YELLOW}Applying instance migrations...${RESET}\n`);
    try {
      run("ryoko", buildRyokoArgs(["migrate", "--auto"]));
    } catch {
      console.error(`\n${RED}Migration failed.${RESET}`);
      console.error(`The CLI update succeeded. Retry migrations with: ${DIM}ryoko migrate --auto${RESET}\n`);
      process.exit(1);
    }
  } else if (!opts.noMigrate) {
    console.log(`\n${YELLOW}No instance found at ${JINN_HOME}.${RESET} Skipping migrations.`);
    console.log(`Run ${DIM}ryoko setup${RESET} to create one.\n`);
  }

  console.log(`\n${GREEN}OpenRyoko update complete.${RESET}`);
  console.log(`${DIM}If the gateway is running, restart it to use the updated CLI code.${RESET}\n`);
}
